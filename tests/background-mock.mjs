import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDir);
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function eventHook() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); }
  };
}

function storageArea(initial = {}, quotas = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    ...quotas,
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries([...values].map(([k, v]) => [k, clone(v)]));
      const result = {};
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) {
        for (const key of keys) if (values.has(key)) result[key] = clone(values.get(key));
      } else {
        for (const [key, fallback] of Object.entries(keys)) result[key] = values.has(key) ? clone(values.get(key)) : fallback;
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) values.set(key, clone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
    async getBytesInUse(keys) {
      let entries = [...values.entries()];
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) entries = entries.filter(([key]) => keys.includes(key));
      return entries.reduce((sum, [key, value]) => sum + new TextEncoder().encode(key + JSON.stringify(value)).byteLength, 0);
    }
  };
}

const local = storageArea({}, { QUOTA_BYTES: 10485760 });
const sync = storageArea({}, {
  QUOTA_BYTES: 102400,
  QUOTA_BYTES_PER_ITEM: 8192,
  MAX_ITEMS: 512
});
const session = storageArea();
const syncSetCalls = [];
const syncRemoveCalls = [];
const originalSyncSet = sync.set.bind(sync);
const originalSyncRemove = sync.remove.bind(sync);
sync.set = async (payload) => { syncSetCalls.push(clone(payload)); await originalSyncSet(payload); };
sync.remove = async (keys) => { syncRemoveCalls.push(clone(keys)); await originalSyncRemove(keys); };

const runtimeMessage = eventHook();
const contextClick = eventHook();
const alarmsEvent = eventHook();
const storageChanged = eventHook();
const contextMenus = new Map();

const chrome = {
  runtime: {
    lastError: undefined,
    onMessage: runtimeMessage,
    onInstalled: eventHook(),
    onStartup: eventHook(),
    async openOptionsPage() {}
  },
  storage: {
    local,
    sync,
    session,
    onChanged: storageChanged
  },
  alarms: {
    onAlarm: alarmsEvent,
    async create() {}
  },
  contextMenus: {
    onClicked: contextClick,
    create(properties, callback) {
      contextMenus.set(properties.id, clone(properties));
      callback?.();
      return properties.id;
    },
    async update(id, properties) {
      if (!contextMenus.has(id)) throw new Error("Missing menu");
      contextMenus.set(id, { ...contextMenus.get(id), ...clone(properties) });
    },
    async remove(id) { contextMenus.delete(id); },
    async removeAll() { contextMenus.clear(); }
  },
  scripting: {
    async executeScript() { return [{ result: { ok: true } }]; }
  },
  action: { onClicked: eventHook() }
};

const context = vm.createContext({
  chrome,
  console,
  TextEncoder,
  Uint8Array,
  crypto: crypto.webcrypto,
  structuredClone
});
context.globalThis = context;
context.self = context;
context.importScripts = (...files) => {
  for (const file of files) vm.runInContext(read(file), context, { filename: file });
};
vm.runInContext(read("background.js"), context, { filename: "background.js" });

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for mock background work.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

await waitFor(() => local.values.has("pp:local-meta"));
await new Promise((resolve) => setTimeout(resolve, 50));

let localSetCallCount = 0;
const originalLocalSet = local.set.bind(local);
local.set = async (payload) => {
  localSetCallCount += 1;
  await originalLocalSet(payload);
};

async function send(message) {
  assert.equal(runtimeMessage.listeners.length, 1);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Message timed out: ${message.type}`)), 3000);
    const returned = runtimeMessage.listeners[0](message, {}, (response) => {
      clearTimeout(timeout);
      if (!response.ok) reject(new Error(response.error));
      else resolve(response.data);
    });
    assert.equal(returned, true);
  });
}

// GET_STATE must be read-only. Writing usage metadata here previously created
// an Options-page storage event loop that continually replaced focused fields.
const writesBeforeGetState = localSetCallCount;
await send({ type: "GET_STATE" });
assert.equal(localSetCallCount, writesBeforeGetState);

let state = await send({ type: "ADD_CATEGORY", name: "Research" });
assert.equal(state.categories.filter((category) => !category.deleted).length, 1);
const categoryId = state.categories.find((category) => !category.deleted).id;
assert.ok(contextMenus.size === 0, "Empty categories should not create context menu items");

state = await send({
  type: "UPSERT_PROMPT",
  categoryId,
  title: "Unicode Prompt",
  content: "中文 first line\r\nsecond line"
});
const category = state.categories.find((item) => item.id === categoryId);
assert.equal(category.prompts[0].content, "中文 first line\nsecond line");
assert.ok(contextMenus.has(`pp-cat:${categoryId}`));
assert.ok(contextMenus.has(`pp-prompt:${categoryId}:${category.prompts[0].id}`));
assert.ok(syncSetCalls.length >= 2);
assert.equal(Object.keys(syncSetCalls.at(-1)).length, 1);

// A conflict is valid only while the cloud key is absent. Reconciliation must
// repair stale false-positive conflicts if the category exists in Sync.
const staleConflictMeta = clone(local.values.get("pp:local-meta"));
staleConflictMeta.gcConflicts[categoryId] = {
  categoryId,
  localRevision: category.revision,
  baselineRevision: category.revision,
  detectedAt: Date.now()
};
local.values.set("pp:local-meta", staleConflictMeta);
await context.reconcileFromCloud();
state = await send({ type: "GET_STATE" });
assert.equal(state.meta.gcConflicts[categoryId], undefined);
// Conflict resolution is idempotent when a stale UI action arrives late.
state = await send({ type: "RESOLVE_GC_CONFLICT_KEEP_LOCAL", categoryId });
assert.equal(state.meta.gcConflicts[categoryId], undefined);

// Seed several pending categories at once and verify one batch set call.
const meta = clone(local.values.get("pp:local-meta"));
for (let index = 0; index < 4; index += 1) {
  const id = `batch-${index}`;
  const now = Date.now() + index;
  const record = {
    schemaVersion: 1,
    id,
    name: `Batch ${index}`,
    createdAt: now,
    updatedAt: now,
    revision: `batch-revision-${index}`,
    deleted: false,
    prompts: []
  };
  local.values.set(`pp:category:${id}`, record);
  meta.categoryIds.push(id);
  meta.pendingByCategory[id] = {
    categoryId: id,
    revision: record.revision,
    operation: "UPSERT_OR_DELETE",
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null
  };
}
local.values.set("pp:local-meta", meta);
const beforeBatchCalls = syncSetCalls.length;
await send({ type: "RETRY_PENDING" });
assert.equal(syncSetCalls.length, beforeBatchCalls + 1);
assert.equal(Object.keys(syncSetCalls.at(-1)).length, 4);

state = await send({ type: "DELETE_CATEGORY", categoryId });
const tombstone = state.categories.find((item) => item.id === categoryId);
assert.equal(tombstone.deleted, true);
const oldTombstone = {
  ...tombstone,
  updatedAt: Date.now() - context.PromptStore.TOMBSTONE_TTL_MS - 1000
};
local.values.set(`pp:category:${categoryId}`, oldTombstone);
const gcMeta = clone(local.values.get("pp:local-meta"));
gcMeta.pendingByCategory = {};
gcMeta.syncBaselines[categoryId] = {
  lastSyncedRevision: tombstone.revision,
  lastSyncedAt: Date.now() - context.PromptStore.TOMBSTONE_TTL_MS
};
local.values.set("pp:local-meta", gcMeta);
await send({ type: "RUN_TOMBSTONE_GC" });
assert.ok(syncRemoveCalls.length >= 1);
assert.ok(Array.isArray(syncRemoveCalls.at(-1)));
assert.ok(syncRemoveCalls.at(-1).includes(`pp:v1:category:${categoryId}`));

console.log("Mock background verification passed.");
console.log(`Sync set calls: ${syncSetCalls.length}`);
console.log(`Largest batch: ${Math.max(...syncSetCalls.map((payload) => Object.keys(payload).length))} items`);
