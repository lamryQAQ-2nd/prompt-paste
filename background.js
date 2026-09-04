/* Prompt paste MV3 Service Worker. */
importScripts("vendor/lz-string.min.js", "storage.js");

const PERIODIC_ALARM = "pp-periodic-sync";
const RETRY_ALARM = "pp-sync-retry";
const SYNC_TOTAL_BYTES = chrome.storage.sync.QUOTA_BYTES || 102400;
const SYNC_MAX_ITEMS = chrome.storage.sync.MAX_ITEMS || 512;

// This gate only coalesces work during the current worker lifetime. Durable
// task truth remains in pp:local-meta so termination cannot lose work.
let lifetimeGate = Promise.resolve();

function enqueueWork(task) {
  const run = lifetimeGate.then(task, task);
  lifetimeGate = run.catch(() => undefined);
  return run;
}

async function getMeta() {
  const stored = await chrome.storage.local.get(PromptStore.LOCAL_META_KEY);
  return PromptStore.normalizeMeta(stored[PromptStore.LOCAL_META_KEY]);
}

async function saveMeta(meta) {
  await chrome.storage.local.set({
    [PromptStore.LOCAL_META_KEY]: PromptStore.normalizeMeta(meta)
  });
}

async function getCategories(meta, includeMissing = false) {
  const keys = meta.categoryIds.map(PromptStore.localCategoryKey);
  const stored = keys.length ? await chrome.storage.local.get(keys) : {};
  const categories = new Map();
  for (const categoryId of meta.categoryIds) {
    const category = stored[PromptStore.localCategoryKey(categoryId)];
    if (category || includeMissing) categories.set(categoryId, category || null);
  }
  return categories;
}

function activeCategories(categories) {
  return [...categories.values()]
    .filter((category) => category && !category.deleted)
    .sort((left, right) => left.createdAt - right.createdAt);
}

async function ensureInitialized() {
  const stored = await chrome.storage.local.get(PromptStore.LOCAL_META_KEY);
  if (!stored[PromptStore.LOCAL_META_KEY]) {
    await saveMeta(PromptStore.defaultMeta());
  }
  await chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 30 });
}

function categoryMenuId(categoryId) {
  return `pp-cat:${categoryId}`;
}

function promptMenuId(categoryId, promptId) {
  return `pp-prompt:${categoryId}:${promptId}`;
}

async function refreshMenus() {
  const meta = await getMeta();
  const categories = await getCategories(meta);
  const desired = new Map();

  for (const category of activeCategories(categories)) {
    if (!category.prompts.length) continue;
    const parentId = categoryMenuId(category.id);
    desired.set(parentId, {
      title: category.name,
      contexts: ["editable"]
    });
    for (const prompt of [...category.prompts].sort((a, b) => a.createdAt - b.createdAt)) {
      desired.set(promptMenuId(category.id, prompt.id), {
        title: prompt.title,
        parentId,
        contexts: ["editable"]
      });
    }
  }

  const previous = new Set(meta.menuItemIds);
  for (const staleId of [...previous].filter((id) => !desired.has(id))) {
    try {
      await chrome.contextMenus.remove(staleId);
    } catch {
      // The browser may already have discarded a stale menu item.
    }
  }

  for (const [id, properties] of desired) {
    if (previous.has(id)) {
      try {
        await chrome.contextMenus.update(id, properties);
        continue;
      } catch {
        // Recreate missing items after an extension or browser menu reset.
      }
    }
    try {
      chrome.contextMenus.create({ id, ...properties }, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      console.warn("Could not create context menu item.", id, error);
    }
  }

  const latestMeta = await getMeta();
  latestMeta.menuItemIds = [...desired.keys()];
  await saveMeta(latestMeta);
}

function pruneWriteLog(meta, now = Date.now()) {
  meta.syncWriteTimestamps = meta.syncWriteTimestamps.filter(
    (timestamp) => now - timestamp < 60 * 60 * 1000
  );
  return meta.syncWriteTimestamps;
}

async function reserveSyncWrite() {
  const now = Date.now();
  const meta = await getMeta();
  const log = pruneWriteLog(meta, now);
  const minute = log.filter((timestamp) => now - timestamp < 60 * 1000);
  let retryAt = 0;

  if (minute.length >= PromptStore.MAX_WRITE_MINUTE_SAFE) {
    retryAt = minute[0] + 60 * 1000 + 1000;
  }
  if (log.length >= PromptStore.MAX_WRITE_HOUR_SAFE) {
    retryAt = Math.max(retryAt, log[0] + 60 * 60 * 1000 + 1000);
  }
  if (retryAt) {
    await saveMeta(meta);
    await chrome.alarms.create(RETRY_ALARM, { when: retryAt });
    return { allowed: false, retryAt };
  }

  meta.syncWriteTimestamps.push(now);
  await saveMeta(meta);
  return { allowed: true, retryAt: 0 };
}

async function claimLease() {
  const now = Date.now();
  const meta = await getMeta();
  if (meta.syncLease && meta.syncLease.expiresAt > now) {
    await chrome.alarms.create(RETRY_ALARM, { when: meta.syncLease.expiresAt + 250 });
    return null;
  }
  const ownerRunId = PromptStore.newId();
  meta.syncLease = {
    ownerRunId,
    acquiredAt: now,
    expiresAt: now + PromptStore.LEASE_MS
  };
  await saveMeta(meta);
  const verified = await getMeta();
  return verified.syncLease?.ownerRunId === ownerRunId ? ownerRunId : null;
}

async function renewLease(ownerRunId) {
  const meta = await getMeta();
  if (meta.syncLease?.ownerRunId !== ownerRunId) return false;
  meta.syncLease.expiresAt = Date.now() + PromptStore.LEASE_MS;
  await saveMeta(meta);
  return true;
}

async function releaseLease(ownerRunId) {
  const meta = await getMeta();
  if (meta.syncLease?.ownerRunId === ownerRunId) {
    meta.syncLease = null;
    await saveMeta(meta);
  }
}

async function schedulePendingRetry(meta = null) {
  const state = meta || await getMeta();
  const nextTimes = Object.values(state.pendingByCategory)
    .filter((task) => task.status !== "blocked" && Number.isFinite(task.nextAttemptAt))
    .map((task) => task.nextAttemptAt || Date.now())
    .filter((timestamp) => timestamp > Date.now());
  if (nextTimes.length) {
    await chrome.alarms.create(RETRY_ALARM, { when: Math.min(...nextTimes) });
  }
}

function decodeCloudCategories(cloudValues) {
  const records = new Map();
  const errors = [];
  for (const [key, value] of Object.entries(cloudValues)) {
    const categoryId = PromptStore.categoryIdFromSyncKey(key);
    if (!categoryId) continue;
    try {
      const category = PromptStore.decodeCategory(value);
      if (category.id !== categoryId) throw new Error("Cloud key and category ID do not match.");
      records.set(categoryId, category);
    } catch (error) {
      errors.push(`${key}: ${error.message}`);
    }
  }
  return { records, errors };
}

async function updateUsage() {
  const meta = await getMeta();
  const categories = await getCategories(meta);
  const cloudValues = await chrome.storage.sync.get(null);
  const syncBytes = await chrome.storage.sync.getBytesInUse(null);
  const localBytes = await chrome.storage.local.getBytesInUse(null);
  const cloudCategoryEntries = Object.entries(cloudValues)
    .filter(([key]) => key.startsWith(PromptStore.SYNC_CATEGORY_PREFIX));
  const cloudBytesByKey = new Map(
    cloudCategoryEntries.map(([key, value]) => [key, PromptStore.estimateStoredItemBytes(key, value)])
  );
  let projectedSyncBytes = syncBytes;
  for (const task of Object.values(meta.pendingByCategory)) {
    const category = categories.get(task.categoryId);
    if (!category) continue;
    try {
      const encoded = PromptStore.estimateCategoryBytes(category);
      projectedSyncBytes -= cloudBytesByKey.get(encoded.key) || 0;
      projectedSyncBytes += encoded.bytes;
    } catch {
      // Invalid local data is surfaced elsewhere and excluded from projections.
    }
  }

  let tombstoneCount = 0;
  for (const [, value] of cloudCategoryEntries) {
    try {
      if (PromptStore.decodeCategory(value).deleted) tombstoneCount += 1;
    } catch {
      // Corrupt items still count toward bytes/items but not valid tombstones.
    }
  }
  const eligibleTombstoneCount = [...categories.values()].filter((category) =>
    category &&
    PromptStore.isTombstoneExpired(category) &&
    meta.syncBaselines[category.id] &&
    !meta.pendingByCategory[category.id] &&
    !meta.gcConflicts[category.id]
  ).length;

  meta.usage = {
    syncBytes,
    projectedSyncBytes: Math.max(0, projectedSyncBytes),
    localBytes,
    syncItemCount: cloudCategoryEntries.length,
    tombstoneCount,
    eligibleTombstoneCount,
    updatedAt: Date.now()
  };
  await saveMeta(meta);
  return meta.usage;
}

async function flushPending() {
  const ownerRunId = await claimLease();
  if (!ownerRunId) return { ok: false, deferred: true };

  try {
    let meta = await getMeta();
    const now = Date.now();
    const categories = await getCategories(meta);
    const cloudValues = await chrome.storage.sync.get(null);
    let projectedBytes = Object.entries(cloudValues).reduce(
      (sum, [key, value]) => sum + PromptStore.estimateStoredItemBytes(key, value),
      0
    );
    let projectedItems = Object.keys(cloudValues).length;
    const payload = {};
    const selectedTasks = [];
    const localKeysToRemove = [];
    let metaChanged = false;

    const dueTasks = Object.values(meta.pendingByCategory)
      .filter((task) =>
        task.status !== "blocked" &&
        !meta.gcConflicts[task.categoryId] &&
        Number(task.nextAttemptAt || 0) <= now
      )
      .sort((left, right) => {
        const leftDeleted = Boolean(categories.get(left.categoryId)?.deleted);
        const rightDeleted = Boolean(categories.get(right.categoryId)?.deleted);
        return Number(rightDeleted) - Number(leftDeleted);
      });

    for (const task of dueTasks) {
      const category = categories.get(task.categoryId);
      if (!category || category.revision !== task.revision) {
        delete meta.pendingByCategory[task.categoryId];
        metaChanged = true;
        continue;
      }
      try {
        const encoded = PromptStore.estimateCategoryBytes(category);
        meta.sizeByCategory[category.id] = {
          revision: category.revision,
          estimatedSyncBytes: encoded.bytes
        };
        if (meta.syncBaselines[category.id] && cloudValues[encoded.key] === undefined) {
          const baseline = meta.syncBaselines[category.id];
          const graceEndsAt = baseline.lastSyncedAt + PromptStore.CLOUD_ABSENCE_GRACE_MS;
          if (Date.now() < graceEndsAt) {
            task.status = "pending";
            task.nextAttemptAt = graceEndsAt;
            task.lastError = null;
            metaChanged = true;
            await chrome.alarms.create(RETRY_ALARM, { when: graceEndsAt });
            continue;
          }
          if (category.deleted) {
            delete meta.pendingByCategory[category.id];
            delete meta.syncBaselines[category.id];
            delete meta.gcConflicts[category.id];
            delete meta.sizeByCategory[category.id];
            meta.categoryIds = meta.categoryIds.filter((id) => id !== category.id);
            localKeysToRemove.push(PromptStore.localCategoryKey(category.id));
          } else {
            meta.gcConflicts[category.id] = {
              categoryId: category.id,
              localRevision: category.revision,
              baselineRevision: meta.syncBaselines[category.id].lastSyncedRevision,
              detectedAt: Date.now()
            };
            task.status = "blocked";
            task.lastError = "Cloud deleted this category while this device had offline changes.";
          }
          metaChanged = true;
          continue;
        }
        if (encoded.bytes > PromptStore.SYNC_ITEM_SAFE_BYTES) {
          task.status = "blocked";
          task.lastError = "This category exceeds the safe 8 KB Sync item limit.";
          task.nextAttemptAt = Number.MAX_SAFE_INTEGER;
          metaChanged = true;
          continue;
        }

        const oldValue = cloudValues[encoded.key];
        const oldBytes = oldValue === undefined
          ? 0
          : PromptStore.estimateStoredItemBytes(encoded.key, oldValue);
        const candidateBytes = projectedBytes - oldBytes + encoded.bytes;
        const candidateItems = projectedItems + (oldValue === undefined ? 1 : 0);
        if (candidateBytes > SYNC_TOTAL_BYTES || candidateItems > SYNC_MAX_ITEMS) {
          task.status = "blocked";
          task.lastError = candidateItems > SYNC_MAX_ITEMS
            ? "Chrome Sync has reached its 512-item limit."
            : "Chrome Sync has reached its 100 KB total limit.";
          task.nextAttemptAt = Number.MAX_SAFE_INTEGER;
          metaChanged = true;
          continue;
        }

        payload[encoded.key] = encoded.value;
        selectedTasks.push({ ...task });
        projectedBytes = candidateBytes;
        projectedItems = candidateItems;
        cloudValues[encoded.key] = encoded.value;
        task.status = "inFlight";
        metaChanged = true;
      } catch (error) {
        task.status = "blocked";
        task.lastError = error.message;
        task.nextAttemptAt = Number.MAX_SAFE_INTEGER;
        metaChanged = true;
      }
    }

    if (localKeysToRemove.length) await chrome.storage.local.remove(localKeysToRemove);
    if (metaChanged) await saveMeta(meta);
    if (!selectedTasks.length) return { ok: true, count: 0 };
    if (!await renewLease(ownerRunId)) return { ok: false, deferred: true };

    const reservation = await reserveSyncWrite();
    if (!reservation.allowed) {
      meta = await getMeta();
      for (const selected of selectedTasks) {
        const current = meta.pendingByCategory[selected.categoryId];
        if (current?.revision === selected.revision) {
          current.status = "pending";
          current.nextAttemptAt = reservation.retryAt;
        }
      }
      await saveMeta(meta);
      return { ok: false, deferred: true };
    }

    try {
      await chrome.storage.sync.set(payload);
      meta = await getMeta();
      const completedAt = Date.now();
      for (const selected of selectedTasks) {
        const current = meta.pendingByCategory[selected.categoryId];
        if (current?.revision !== selected.revision) continue;
        meta.syncBaselines[selected.categoryId] = {
          lastSyncedRevision: selected.revision,
          lastSyncedAt: completedAt
        };
        delete meta.pendingByCategory[selected.categoryId];
      }
      meta.lastSuccessfulSyncAt = completedAt;
      meta.lastSyncDirection = "push";
      meta.lastSyncError = null;
      await saveMeta(meta);
      return { ok: true, count: selectedTasks.length };
    } catch (error) {
      meta = await getMeta();
      for (const selected of selectedTasks) {
        const current = meta.pendingByCategory[selected.categoryId];
        if (current?.revision !== selected.revision) continue;
        current.status = "pending";
        current.attempts = Number(current.attempts || 0) + 1;
        current.nextAttemptAt = Date.now() + PromptStore.retryDelay(current.attempts);
        current.lastError = error.message;
      }
      meta.lastSyncError = error.message;
      await saveMeta(meta);
      await schedulePendingRetry(meta);
      return { ok: false, error: error.message };
    }
  } finally {
    await releaseLease(ownerRunId);
    await updateUsage().catch(() => undefined);
  }
}

async function runTombstoneGc() {
  const ownerRunId = await claimLease();
  if (!ownerRunId) return { ok: false, deferred: true };
  try {
    let meta = await getMeta();
    if (meta.exclusiveJob) return { ok: false, deferred: true };
    const categories = await getCategories(meta);
    const expired = [...categories.values()].filter((category) =>
      category &&
      PromptStore.isTombstoneExpired(category) &&
      meta.syncBaselines[category.id] &&
      !meta.pendingByCategory[category.id] &&
      !meta.gcConflicts[category.id]
    );
    if (!expired.length) {
      meta.lastGcAt = Date.now();
      meta.lastGcRemovedCount = 0;
      await saveMeta(meta);
      return { ok: true, count: 0 };
    }

    const reservation = await reserveSyncWrite();
    if (!reservation.allowed) return { ok: false, deferred: true };
    const syncKeys = expired.map((category) => PromptStore.syncCategoryKey(category.id));
    await chrome.storage.sync.remove(syncKeys);

    meta = await getMeta();
    const localKeys = [];
    for (const category of expired) {
      localKeys.push(PromptStore.localCategoryKey(category.id));
      meta.categoryIds = meta.categoryIds.filter((id) => id !== category.id);
      delete meta.syncBaselines[category.id];
      delete meta.pendingByCategory[category.id];
      delete meta.gcConflicts[category.id];
      delete meta.sizeByCategory[category.id];
    }
    meta.lastGcAt = Date.now();
    meta.lastGcRemovedCount = expired.length;
    meta.lastSyncError = null;
    await chrome.storage.local.remove(localKeys);
    await saveMeta(meta);
    await refreshMenus();
    return { ok: true, count: expired.length };
  } catch (error) {
    const meta = await getMeta();
    meta.lastSyncError = `Tombstone cleanup failed: ${error.message}`;
    await saveMeta(meta);
    await chrome.alarms.create(RETRY_ALARM, { when: Date.now() + PromptStore.retryDelay(1) });
    return { ok: false, error: error.message };
  } finally {
    await releaseLease(ownerRunId);
    await updateUsage().catch(() => undefined);
  }
}

async function reconcileFromCloud() {
  let meta = await getMeta();
  const local = await getCategories(meta);
  const cloudValues = await chrome.storage.sync.get(null);
  const decoded = decodeCloudCategories(cloudValues);
  const ids = new Set([...meta.categoryIds, ...decoded.records.keys()]);
  const setValues = {};
  const removeLocalKeys = [];

  for (const categoryId of ids) {
    const localCategory = local.get(categoryId);
    const cloudCategory = decoded.records.get(categoryId);
    const pending = meta.pendingByCategory[categoryId];
    const baseline = meta.syncBaselines[categoryId];

    if (localCategory && cloudCategory) {
      // A GC conflict is meaningful only while the category key is absent from
      // Sync. If the key exists again, clear any stale conflict left by an
      // earlier interrupted or out-of-order reconciliation before comparing
      // revisions. This also repairs false conflicts created by older builds.
      delete meta.gcConflicts[categoryId];
      const comparison = PromptStore.compareCategories(localCategory, cloudCategory);
      if (comparison < 0) {
        setValues[PromptStore.localCategoryKey(categoryId)] = cloudCategory;
        meta.syncBaselines[categoryId] = {
          lastSyncedRevision: cloudCategory.revision,
          lastSyncedAt: Date.now()
        };
        delete meta.pendingByCategory[categoryId];
        delete meta.gcConflicts[categoryId];
        meta.sizeByCategory[categoryId] = {
          revision: cloudCategory.revision,
          estimatedSyncBytes: PromptStore.estimateCategoryBytes(cloudCategory).bytes
        };
      } else if (comparison > 0) {
        meta.pendingByCategory[categoryId] = PromptStore.makePending(localCategory, pending);
      } else {
        meta.syncBaselines[categoryId] = {
          lastSyncedRevision: cloudCategory.revision,
          lastSyncedAt: Date.now()
        };
        if (pending?.revision === cloudCategory.revision) delete meta.pendingByCategory[categoryId];
        delete meta.gcConflicts[categoryId];
      }
      continue;
    }

    if (!localCategory && cloudCategory) {
      setValues[PromptStore.localCategoryKey(categoryId)] = cloudCategory;
      if (!meta.categoryIds.includes(categoryId)) meta.categoryIds.push(categoryId);
      meta.syncBaselines[categoryId] = {
        lastSyncedRevision: cloudCategory.revision,
        lastSyncedAt: Date.now()
      };
      meta.sizeByCategory[categoryId] = {
        revision: cloudCategory.revision,
        estimatedSyncBytes: PromptStore.estimateCategoryBytes(cloudCategory).bytes
      };
      continue;
    }

    if (localCategory && !cloudCategory) {
      if (!baseline) {
        meta.pendingByCategory[categoryId] = PromptStore.makePending(localCategory, pending);
      } else if (Date.now() < baseline.lastSyncedAt + PromptStore.CLOUD_ABSENCE_GRACE_MS) {
        const retryAt = baseline.lastSyncedAt + PromptStore.CLOUD_ABSENCE_GRACE_MS;
        // Older builds could create a conflict during this short propagation
        // window. Treat it as pending observation and repair the stale flag.
        delete meta.gcConflicts[categoryId];
        if (pending) {
          pending.status = "pending";
          pending.nextAttemptAt = Math.max(Number(pending.nextAttemptAt || 0), retryAt);
          pending.lastError = null;
        }
        await chrome.alarms.create(RETRY_ALARM, { when: retryAt });
      } else if (pending && pending.revision !== baseline.lastSyncedRevision) {
        meta.gcConflicts[categoryId] = {
          categoryId,
          localRevision: localCategory.revision,
          baselineRevision: baseline.lastSyncedRevision,
          detectedAt: Date.now()
        };
        pending.status = "blocked";
        pending.lastError = "Cloud deleted this category while this device had offline changes.";
      } else {
        removeLocalKeys.push(PromptStore.localCategoryKey(categoryId));
        meta.categoryIds = meta.categoryIds.filter((id) => id !== categoryId);
        delete meta.syncBaselines[categoryId];
        delete meta.pendingByCategory[categoryId];
        delete meta.gcConflicts[categoryId];
        delete meta.sizeByCategory[categoryId];
      }
    }
  }

  if (Object.keys(setValues).length) await chrome.storage.local.set(setValues);
  if (removeLocalKeys.length) await chrome.storage.local.remove(removeLocalKeys);
  meta.lastSuccessfulSyncAt = Date.now();
  meta.lastSyncDirection = "automatic";
  meta.lastSyncError = decoded.errors.length ? decoded.errors.join(" | ") : null;
  await saveMeta(meta);
  await refreshMenus();
  await flushPending();
  await runTombstoneGc();
  await updateUsage();
  return { ok: decoded.errors.length === 0, errors: decoded.errors };
}

async function forcePush(resume = false) {
  let meta = await getMeta();
  if (!resume) {
    meta.exclusiveJob = {
      id: PromptStore.newId(),
      type: "FORCE_PUSH",
      phase: "prepare",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      lastError: null
    };
    await saveMeta(meta);
  }

  try {
    const cloudValues = await chrome.storage.sync.get(null);
    meta = await getMeta();
    const categories = await getCategories(meta);
    const localIds = new Set(meta.categoryIds);
    const localWrites = {};

    for (const key of Object.keys(cloudValues)) {
      const categoryId = PromptStore.categoryIdFromSyncKey(key);
      if (!categoryId || localIds.has(categoryId)) continue;
      let createdAt = Date.now();
      try {
        createdAt = PromptStore.decodeCategory(cloudValues[key]).createdAt;
      } catch {
        // A force push replaces even corrupt cloud-only records with tombstones.
      }
      const tombstone = {
        schemaVersion: PromptStore.SCHEMA_VERSION,
        id: categoryId,
        name: "",
        createdAt,
        updatedAt: Date.now(),
        revision: PromptStore.newId(),
        deleted: true,
        prompts: []
      };
      categories.set(categoryId, tombstone);
      meta.categoryIds.push(categoryId);
      localWrites[PromptStore.localCategoryKey(categoryId)] = tombstone;
    }
    if (Object.keys(localWrites).length) await chrome.storage.local.set(localWrites);

    const payload = {};
    let totalBytes = 0;
    for (const category of categories.values()) {
      if (!category) continue;
      const encoded = PromptStore.estimateCategoryBytes(category);
      if (encoded.bytes > PromptStore.SYNC_ITEM_SAFE_BYTES) {
        throw new Error(`Category "${category.name || category.id}" exceeds the safe 8 KB item limit.`);
      }
      payload[encoded.key] = encoded.value;
      totalBytes += encoded.bytes;
    }
    if (Object.keys(payload).length > SYNC_MAX_ITEMS) throw new Error("The force push exceeds 512 Sync items.");
    if (totalBytes > SYNC_TOTAL_BYTES) throw new Error("The force push exceeds 100 KB of Sync storage.");

    meta.exclusiveJob.phase = "commit";
    meta.exclusiveJob.updatedAt = Date.now();
    await saveMeta(meta);
    if (Object.keys(payload).length) {
      const reservation = await reserveSyncWrite();
      if (!reservation.allowed) throw new Error("Sync write rate is temporarily limited. Retry later.");
      await chrome.storage.sync.set(payload);
    }

    meta = await getMeta();
    const completedAt = Date.now();
    for (const category of categories.values()) {
      if (!category) continue;
      meta.syncBaselines[category.id] = {
        lastSyncedRevision: category.revision,
        lastSyncedAt: completedAt
      };
      delete meta.pendingByCategory[category.id];
      delete meta.gcConflicts[category.id];
    }
    meta.exclusiveJob = null;
    meta.lastSuccessfulSyncAt = completedAt;
    meta.lastSyncDirection = "force push";
    meta.lastSyncError = null;
    await saveMeta(meta);
    await runTombstoneGc();
    await updateUsage();
    return { ok: true };
  } catch (error) {
    meta = await getMeta();
    if (meta.exclusiveJob?.type === "FORCE_PUSH") {
      meta.exclusiveJob.attempts = Number(meta.exclusiveJob.attempts || 0) + 1;
      meta.exclusiveJob.lastError = error.message;
      meta.exclusiveJob.updatedAt = Date.now();
    }
    meta.lastSyncError = error.message;
    await saveMeta(meta);
    throw error;
  }
}

async function forcePull(resume = false) {
  let meta = await getMeta();
  if (!resume) {
    meta.exclusiveJob = {
      id: PromptStore.newId(),
      type: "FORCE_PULL",
      phase: "prepare",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      lastError: null
    };
    await saveMeta(meta);
  }

  try {
    const cloudValues = await chrome.storage.sync.get(null);
    const decoded = decodeCloudCategories(cloudValues);
    if (decoded.errors.length) throw new Error(`Cloud data is invalid: ${decoded.errors.join(" | ")}`);
    meta = await getMeta();
    const oldLocalKeys = meta.categoryIds.map(PromptStore.localCategoryKey);
    const newLocalValues = {};
    const newIds = [];
    const baselines = {};
    const sizes = {};
    const now = Date.now();
    for (const category of decoded.records.values()) {
      newIds.push(category.id);
      newLocalValues[PromptStore.localCategoryKey(category.id)] = category;
      baselines[category.id] = { lastSyncedRevision: category.revision, lastSyncedAt: now };
      sizes[category.id] = {
        revision: category.revision,
        estimatedSyncBytes: PromptStore.estimateCategoryBytes(category).bytes
      };
    }

    meta.exclusiveJob.phase = "commit";
    meta.exclusiveJob.updatedAt = now;
    meta.categoryIds = newIds;
    meta.syncBaselines = baselines;
    meta.pendingByCategory = {};
    meta.gcConflicts = {};
    meta.sizeByCategory = sizes;
    await chrome.storage.local.set({ ...newLocalValues, [PromptStore.LOCAL_META_KEY]: meta });

    const keep = new Set(Object.keys(newLocalValues));
    const obsolete = oldLocalKeys.filter((key) => !keep.has(key));
    if (obsolete.length) await chrome.storage.local.remove(obsolete);

    meta = await getMeta();
    meta.exclusiveJob = null;
    meta.lastSuccessfulSyncAt = now;
    meta.lastSyncDirection = "force pull";
    meta.lastSyncError = null;
    await saveMeta(meta);
    await refreshMenus();
    await runTombstoneGc();
    await updateUsage();
    return { ok: true };
  } catch (error) {
    meta = await getMeta();
    if (meta.exclusiveJob?.type === "FORCE_PULL") {
      meta.exclusiveJob.attempts = Number(meta.exclusiveJob.attempts || 0) + 1;
      meta.exclusiveJob.lastError = error.message;
      meta.exclusiveJob.updatedAt = Date.now();
    }
    meta.lastSyncError = error.message;
    await saveMeta(meta);
    throw error;
  }
}

async function recoverDurableWork() {
  await ensureInitialized();
  const meta = await getMeta();
  if (meta.syncLease && meta.syncLease.expiresAt <= Date.now()) {
    meta.syncLease = null;
    await saveMeta(meta);
  }
  const latest = await getMeta();
  if (latest.exclusiveJob?.type === "FORCE_PUSH") return forcePush(true);
  if (latest.exclusiveJob?.type === "FORCE_PULL") return forcePull(true);
  return reconcileFromCloud();
}

async function commitCategory(category, meta) {
  const encoded = PromptStore.estimateCategoryBytes(category);
  meta.sizeByCategory[category.id] = {
    revision: category.revision,
    estimatedSyncBytes: encoded.bytes
  };
  meta.pendingByCategory[category.id] = PromptStore.makePending(
    category,
    meta.pendingByCategory[category.id]
  );
  delete meta.gcConflicts[category.id];
  if (!meta.categoryIds.includes(category.id)) meta.categoryIds.push(category.id);
  await chrome.storage.local.set({
    [PromptStore.localCategoryKey(category.id)]: category,
    [PromptStore.LOCAL_META_KEY]: meta
  });
  await refreshMenus();
  await flushPending();
  return getState();
}

async function addCategory(message) {
  const name = PromptStore.validateCategoryName(message.name);
  const meta = await getMeta();
  const categories = await getCategories(meta);
  if (activeCategories(categories).some((category) => category.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("A category with this name already exists.");
  }
  const now = Date.now();
  return commitCategory({
    schemaVersion: PromptStore.SCHEMA_VERSION,
    id: PromptStore.newId(),
    name,
    createdAt: now,
    updatedAt: now,
    revision: PromptStore.newId(),
    deleted: false,
    prompts: []
  }, meta);
}

async function renameCategory(message) {
  const name = PromptStore.validateCategoryName(message.name);
  const meta = await getMeta();
  const categories = await getCategories(meta);
  const category = categories.get(message.categoryId);
  if (!category || category.deleted) throw new Error("Category not found.");
  if (activeCategories(categories).some((item) =>
    item.id !== category.id && item.name.toLowerCase() === name.toLowerCase()
  )) throw new Error("A category with this name already exists.");
  return commitCategory({
    ...category,
    name,
    updatedAt: Date.now(),
    revision: PromptStore.newId()
  }, meta);
}

async function deleteCategory(message) {
  const meta = await getMeta();
  const categories = await getCategories(meta);
  const category = categories.get(message.categoryId);
  if (!category || category.deleted) throw new Error("Category not found.");
  return commitCategory({
    schemaVersion: PromptStore.SCHEMA_VERSION,
    id: category.id,
    name: "",
    createdAt: category.createdAt,
    updatedAt: Date.now(),
    revision: PromptStore.newId(),
    deleted: true,
    prompts: []
  }, meta);
}

async function upsertPrompt(message) {
  const input = PromptStore.validatePromptInput(message.title, message.content);
  const meta = await getMeta();
  const categories = await getCategories(meta);
  const category = categories.get(message.categoryId);
  if (!category || category.deleted) throw new Error("Category not found.");
  const duplicate = category.prompts.some((prompt) =>
    prompt.id !== message.promptId && prompt.title.toLowerCase() === input.title.toLowerCase()
  );
  if (duplicate) throw new Error("A Prompt with this title already exists in this category.");
  const now = Date.now();
  const prompts = [...category.prompts];
  const index = prompts.findIndex((prompt) => prompt.id === message.promptId);
  if (index >= 0) {
    prompts[index] = { ...prompts[index], ...input, updatedAt: now };
  } else {
    prompts.push({ id: PromptStore.newId(), ...input, createdAt: now, updatedAt: now });
  }
  return commitCategory({
    ...category,
    prompts,
    updatedAt: now,
    revision: PromptStore.newId()
  }, meta);
}

async function deletePrompt(message) {
  const meta = await getMeta();
  const categories = await getCategories(meta);
  const category = categories.get(message.categoryId);
  if (!category || category.deleted) throw new Error("Category not found.");
  const prompts = category.prompts.filter((prompt) => prompt.id !== message.promptId);
  if (prompts.length === category.prompts.length) throw new Error("Prompt not found.");
  return commitCategory({
    ...category,
    prompts,
    updatedAt: Date.now(),
    revision: PromptStore.newId()
  }, meta);
}

async function resolveGcConflict(message, keepLocal) {
  const meta = await getMeta();
  const conflict = meta.gcConflicts[message.categoryId];
  if (!conflict) return getState();
  if (keepLocal) {
    const categories = await getCategories(meta);
    const category = categories.get(message.categoryId);
    if (!category) throw new Error("Local category not found.");
    delete meta.syncBaselines[category.id];
    delete meta.gcConflicts[category.id];
    meta.pendingByCategory[category.id] = PromptStore.makePending(category);
    await saveMeta(meta);
    await flushPending();
  } else {
    await chrome.storage.local.remove(PromptStore.localCategoryKey(message.categoryId));
    meta.categoryIds = meta.categoryIds.filter((id) => id !== message.categoryId);
    delete meta.syncBaselines[message.categoryId];
    delete meta.pendingByCategory[message.categoryId];
    delete meta.gcConflicts[message.categoryId];
    delete meta.sizeByCategory[message.categoryId];
    await saveMeta(meta);
    await refreshMenus();
  }
  return getState();
}

async function getState() {
  const meta = await getMeta();
  const categories = await getCategories(meta);
  return {
    meta,
    usage: meta.usage,
    quotas: {
      syncBytes: SYNC_TOTAL_BYTES,
      syncItemBytes: chrome.storage.sync.QUOTA_BYTES_PER_ITEM || 8192,
      syncItems: SYNC_MAX_ITEMS,
      localBytes: chrome.storage.local.QUOTA_BYTES || 10485760
    },
    categories: [...categories.values()].filter(Boolean).sort((a, b) => a.createdAt - b.createdAt)
  };
}

async function claimInsertionRequest(sender) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  if (!Number.isInteger(tabId)) throw new Error("Insertion request has no source tab.");
  const key = PromptStore.insertionRequestKey(tabId, frameId);
  const stored = await chrome.storage.session.get(key);
  const request = stored[key];
  if (request) await chrome.storage.session.remove(key);
  if (!request || Date.now() - request.createdAt > PromptStore.INSERT_REQUEST_TTL_MS) {
    throw new Error("Insertion request expired.");
  }
  return { requestId: request.requestId, promptText: request.promptText };
}

async function insertPromptFromMenu(info, tab) {
  if (!tab?.id || typeof info.menuItemId !== "string" || !info.menuItemId.startsWith("pp-prompt:")) return;
  const [, categoryId, promptId] = info.menuItemId.split(":");
  const meta = await getMeta();
  const stored = await chrome.storage.local.get(PromptStore.localCategoryKey(categoryId));
  const category = stored[PromptStore.localCategoryKey(categoryId)];
  const prompt = category?.prompts?.find((item) => item.id === promptId);
  if (!prompt) throw new Error("Prompt not found in local storage.");
  const frameId = info.frameId ?? 0;
  const requestKey = PromptStore.insertionRequestKey(tab.id, frameId);
  await chrome.storage.session.set({
    [requestKey]: {
      requestId: PromptStore.newId(),
      promptText: PromptStore.normalizePromptContent(prompt.content),
      createdAt: Date.now()
    }
  });
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      files: ["content.js"]
    });
  } finally {
    await chrome.storage.session.remove(requestKey).catch(() => undefined);
  }
}

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATE": return getState();
    case "GET_STORAGE_USAGE": return updateUsage();
    case "ADD_CATEGORY": return addCategory(message);
    case "RENAME_CATEGORY": return renameCategory(message);
    case "DELETE_CATEGORY": return deleteCategory(message);
    case "UPSERT_PROMPT": return upsertPrompt(message);
    case "DELETE_PROMPT": return deletePrompt(message);
    case "FORCE_PUSH": return forcePush(false);
    case "FORCE_PULL": return forcePull(false);
    case "RETRY_PENDING": {
      const meta = await getMeta();
      for (const task of Object.values(meta.pendingByCategory)) {
        if (task.status !== "blocked" || !task.lastError?.includes("8 KB")) {
          task.status = "pending";
          task.nextAttemptAt = 0;
        }
      }
      await saveMeta(meta);
      await flushPending();
      return getState();
    }
    case "RUN_TOMBSTONE_GC": await runTombstoneGc(); return getState();
    case "RESOLVE_GC_CONFLICT_KEEP_LOCAL": return resolveGcConflict(message, true);
    case "RESOLVE_GC_CONFLICT_ACCEPT_DELETE": return resolveGcConflict(message, false);
    default: throw new Error("Unknown extension message.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CLAIM_INSERT_REQUEST") {
    claimInsertionRequest(sender)
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  enqueueWork(() => handleMessage(message))
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  void enqueueWork(async () => {
    await ensureInitialized();
    await refreshMenus();
    await recoverDurableWork();
  });
});

chrome.runtime.onStartup.addListener(() => {
  void enqueueWork(recoverDurableWork);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM || alarm.name === RETRY_ALARM) {
    void enqueueWork(recoverDurableWork);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && Object.keys(changes).some((key) => key.startsWith(PromptStore.SYNC_CATEGORY_PREFIX))) {
    void enqueueWork(reconcileFromCloud);
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void enqueueWork(() => insertPromptFromMenu(info, tab)).catch((error) => {
    console.warn("Prompt insertion failed.", error);
  });
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

// Any event that wakes a new worker instance also gets a recovery pass.
void enqueueWork(recoverDurableWork).catch((error) => {
  console.warn("Background recovery failed.", error);
});
