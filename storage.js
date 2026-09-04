/* Shared data, validation, compression, and quota helpers. */
globalThis.PromptStore = (() => {
  "use strict";

  const SCHEMA_VERSION = 1;
  const LOCAL_META_KEY = "pp:local-meta";
  const LOCAL_CATEGORY_PREFIX = "pp:category:";
  const SYNC_CATEGORY_PREFIX = "pp:v1:category:";
  const INSERT_REQUEST_PREFIX = "pp:insert:";
  const CODEC_PREFIX = "lz16:v1:";
  const SYNC_ITEM_SAFE_BYTES = 8000;
  const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const INSERT_REQUEST_TTL_MS = 30 * 1000;
  const LEASE_MS = 60 * 1000;
  const CLOUD_ABSENCE_GRACE_MS = 2 * 60 * 1000;
  const MAX_WRITE_MINUTE_SAFE = 100;
  const MAX_WRITE_HOUR_SAFE = 1500;
  const RETRY_DELAYS_MS = [30000, 60000, 120000, 300000, 900000];

  function newId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes].map((value, index) => {
      const separator = [4, 6, 8, 10].includes(index) ? "-" : "";
      return separator + value.toString(16).padStart(2, "0");
    }).join("");
  }

  function defaultMeta() {
    return {
      schemaVersion: SCHEMA_VERSION,
      categoryIds: [],
      syncBaselines: {},
      pendingByCategory: {},
      gcConflicts: {},
      exclusiveJob: null,
      syncLease: null,
      syncWriteTimestamps: [],
      lastSuccessfulSyncAt: 0,
      lastSyncDirection: null,
      lastSyncError: null,
      lastGcAt: 0,
      lastGcRemovedCount: 0,
      menuItemIds: [],
      sizeByCategory: {},
      usage: {
        syncBytes: 0,
        projectedSyncBytes: 0,
        localBytes: 0,
        syncItemCount: 0,
        tombstoneCount: 0,
        eligibleTombstoneCount: 0,
        updatedAt: 0
      }
    };
  }

  function normalizeMeta(value) {
    const base = defaultMeta();
    if (!value || typeof value !== "object") return base;
    return {
      ...base,
      ...value,
      schemaVersion: SCHEMA_VERSION,
      categoryIds: Array.isArray(value.categoryIds)
        ? [...new Set(value.categoryIds.filter(isNonEmptyString))]
        : [],
      syncBaselines: isPlainObject(value.syncBaselines) ? value.syncBaselines : {},
      pendingByCategory: isPlainObject(value.pendingByCategory) ? value.pendingByCategory : {},
      gcConflicts: isPlainObject(value.gcConflicts) ? value.gcConflicts : {},
      syncWriteTimestamps: Array.isArray(value.syncWriteTimestamps)
        ? value.syncWriteTimestamps.filter(Number.isFinite)
        : [],
      menuItemIds: Array.isArray(value.menuItemIds) ? value.menuItemIds : [],
      sizeByCategory: isPlainObject(value.sizeByCategory) ? value.sizeByCategory : {},
      usage: isPlainObject(value.usage) ? { ...base.usage, ...value.usage } : base.usage
    };
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
  }

  function normalizePromptContent(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  function validateCategoryName(value) {
    const name = String(value ?? "").trim();
    if (!name) throw new Error("Category name is required.");
    if (name.length > 120) throw new Error("Category names must be 120 characters or fewer.");
    return name;
  }

  function validatePromptInput(titleValue, contentValue) {
    const title = String(titleValue ?? "").trim();
    const content = normalizePromptContent(contentValue);
    if (!title) throw new Error("Prompt title is required.");
    if (title.length > 200) throw new Error("Prompt titles must be 200 characters or fewer.");
    if (!content.trim()) throw new Error("Prompt content is required.");
    return { title, content };
  }

  function validateCloudCategory(input) {
    if (!isPlainObject(input)) throw new Error("Cloud category is not an object.");
    if (input.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported cloud schema version.");
    if (!isNonEmptyString(input.id)) throw new Error("Cloud category has no valid ID.");
    if (!isNonEmptyString(input.revision)) throw new Error("Cloud category has no valid revision.");
    if (!Number.isFinite(input.createdAt) || !Number.isFinite(input.updatedAt)) {
      throw new Error("Cloud category has invalid timestamps.");
    }
    if (typeof input.deleted !== "boolean") throw new Error("Cloud category has an invalid deleted flag.");
    if (!Array.isArray(input.prompts)) throw new Error("Cloud category has no Prompt array.");

    if (input.deleted) {
      if (input.prompts.length) throw new Error("A tombstone cannot contain Prompts.");
      return {
        schemaVersion: SCHEMA_VERSION,
        id: input.id,
        name: "",
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        revision: input.revision,
        deleted: true,
        prompts: []
      };
    }

    const name = validateCategoryName(input.name);
    const promptIds = new Set();
    const promptTitles = new Set();
    const prompts = input.prompts.map((prompt) => {
      if (!isPlainObject(prompt) || !isNonEmptyString(prompt.id)) {
        throw new Error("Cloud Prompt has no valid ID.");
      }
      if (promptIds.has(prompt.id)) throw new Error("Cloud category contains duplicate Prompt IDs.");
      if (!Number.isFinite(prompt.createdAt) || !Number.isFinite(prompt.updatedAt)) {
        throw new Error("Cloud Prompt has invalid timestamps.");
      }
      const normalized = validatePromptInput(prompt.title, prompt.content);
      if (normalized.content !== prompt.content) {
        throw new Error("Cloud Prompt contains non-canonical line endings.");
      }
      const titleKey = normalized.title.toLowerCase();
      if (promptTitles.has(titleKey)) throw new Error("Cloud category contains duplicate Prompt titles.");
      promptIds.add(prompt.id);
      promptTitles.add(titleKey);
      return {
        id: prompt.id,
        title: normalized.title,
        content: normalized.content,
        createdAt: prompt.createdAt,
        updatedAt: prompt.updatedAt
      };
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      id: input.id,
      name,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      revision: input.revision,
      deleted: false,
      prompts
    };
  }

  function localCategoryKey(categoryId) {
    return `${LOCAL_CATEGORY_PREFIX}${categoryId}`;
  }

  function syncCategoryKey(categoryId) {
    return `${SYNC_CATEGORY_PREFIX}${categoryId}`;
  }

  function categoryIdFromSyncKey(key) {
    return key.startsWith(SYNC_CATEGORY_PREFIX) ? key.slice(SYNC_CATEGORY_PREFIX.length) : null;
  }

  function insertionRequestKey(tabId, frameId) {
    return `${INSERT_REQUEST_PREFIX}${tabId}:${frameId}`;
  }

  function encodeCategory(category) {
    const validated = validateCloudCategory(category);
    return `${CODEC_PREFIX}${LZString.compressToUTF16(JSON.stringify(validated))}`;
  }

  function decodeCategory(value) {
    if (typeof value !== "string") throw new Error("Cloud value is not a string.");
    if (!value.startsWith(CODEC_PREFIX)) throw new Error("Cloud value uses an unknown codec.");
    const json = LZString.decompressFromUTF16(value.slice(CODEC_PREFIX.length));
    if (json === null || typeof json !== "string") throw new Error("Cloud value could not be decompressed.");
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Cloud value contains invalid JSON.");
    }
    return validateCloudCategory(parsed);
  }

  function utf8Bytes(value) {
    return new TextEncoder().encode(value).byteLength;
  }

  function estimateStoredItemBytes(key, value) {
    return utf8Bytes(key) + utf8Bytes(JSON.stringify(value));
  }

  function estimateCategoryBytes(category) {
    const key = syncCategoryKey(category.id);
    const value = encodeCategory(category);
    return { key, value, bytes: estimateStoredItemBytes(key, value) };
  }

  function compareCategories(left, right) {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? 1 : -1;
    if (left.revision === right.revision) return 0;
    return left.revision > right.revision ? 1 : -1;
  }

  function isTombstoneExpired(category, now = Date.now()) {
    return Boolean(category?.deleted) && now - category.updatedAt >= TOMBSTONE_TTL_MS;
  }

  function retryDelay(attempts) {
    const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(attempts || 1) - 1));
    return RETRY_DELAYS_MS[index];
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function makePending(category, previous = null) {
    return {
      categoryId: category.id,
      revision: category.revision,
      operation: "UPSERT_OR_DELETE",
      status: "pending",
      attempts: previous?.revision === category.revision ? Number(previous.attempts || 0) : 0,
      nextAttemptAt: 0,
      lastError: null
    };
  }

  return Object.freeze({
    SCHEMA_VERSION,
    LOCAL_META_KEY,
    LOCAL_CATEGORY_PREFIX,
    SYNC_CATEGORY_PREFIX,
    INSERT_REQUEST_PREFIX,
    CODEC_PREFIX,
    SYNC_ITEM_SAFE_BYTES,
    TOMBSTONE_TTL_MS,
    INSERT_REQUEST_TTL_MS,
    LEASE_MS,
    CLOUD_ABSENCE_GRACE_MS,
    MAX_WRITE_MINUTE_SAFE,
    MAX_WRITE_HOUR_SAFE,
    RETRY_DELAYS_MS,
    newId,
    defaultMeta,
    normalizeMeta,
    normalizePromptContent,
    validateCategoryName,
    validatePromptInput,
    validateCloudCategory,
    localCategoryKey,
    syncCategoryKey,
    categoryIdFromSyncKey,
    insertionRequestKey,
    encodeCategory,
    decodeCategory,
    estimateStoredItemBytes,
    estimateCategoryBytes,
    compareCategories,
    isTombstoneExpired,
    retryDelay,
    formatBytes,
    makePending
  });
})();
