import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDir);
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const manifest = JSON.parse(read("manifest.json"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(
  [...manifest.permissions].sort(),
  ["activeTab", "alarms", "contextMenus", "scripting", "storage"].sort()
);
assert.equal("host_permissions" in manifest, false);
assert.equal("content_scripts" in manifest, false);
assert.match(manifest.key, /^[A-Za-z0-9+/]+={0,2}$/);

const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
const extensionId = [...digest]
  .flatMap((byte) => byte.toString(16).padStart(2, "0").split(""))
  .map((nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)))
  .join("");
assert.equal(extensionId, "ggdjhafkodfdkdpjfiiaghedigdbdgpi");

const context = vm.createContext({
  console,
  TextEncoder,
  Uint8Array,
  crypto: crypto.webcrypto
});
context.globalThis = context;
context.self = context;
vm.runInContext(read("vendor/lz-string.min.js"), context, { filename: "lz-string.min.js" });
vm.runInContext(read("storage.js"), context, { filename: "storage.js" });
const store = context.PromptStore;

assert.equal(store.normalizePromptContent("one\r\ntwo\rthree\nfour"), "one\ntwo\nthree\nfour");

const promptInput = store.validatePromptInput("  Unicode test  ", "中文 😀\r\nsecond line");
assert.equal(promptInput.title, "Unicode test");
assert.equal(promptInput.content, "中文 😀\nsecond line");

const category = {
  schemaVersion: 1,
  id: "category-id",
  name: "Research",
  createdAt: 1,
  updatedAt: 2,
  revision: "revision-id",
  deleted: false,
  prompts: [{
    id: "prompt-id",
    title: promptInput.title,
    content: promptInput.content,
    createdAt: 1,
    updatedAt: 2
  }]
};

const encoded = store.encodeCategory(category);
assert.ok(encoded.startsWith("lz16:v1:"));
assert.deepEqual(JSON.parse(JSON.stringify(store.decodeCategory(encoded))), category);
assert.ok(store.estimateCategoryBytes(category).bytes > 0);
assert.throws(() => store.decodeCategory(`${encoded.slice(0, -4)}broken`));
assert.throws(() => store.validatePromptInput("", "body"));
assert.throws(() => store.validatePromptInput("title", "   "));

const content = read("content.js").trim();
assert.ok(content.startsWith("(async () => {"));
assert.ok(content.endsWith("})();"));
assert.doesNotMatch(content, /globalThis\.__prompte|window\.__prompte/);
assert.doesNotMatch(content, /addListener\s*\(/);

for (const file of ["background.js", "storage.js", "options.js", "content.js"]) {
  const source = read(file);
  assert.doesNotMatch(source, /window\.LZString/);
  assert.doesNotMatch(source, /LZString\.compress\s*\(/);
  assert.doesNotMatch(source, /LZString\.decompress\s*\(/);
}

const background = read("background.js");
assert.match(background, /chrome\.storage\.sync\.set\(payload\)/);
assert.match(background, /chrome\.storage\.sync\.remove\(syncKeys\)/);
assert.doesNotMatch(background, /for\s*\([^)]*\)[\s\S]{0,160}chrome\.storage\.sync\.set\s*\(/);

for (const file of ["manifest.json", "background.js", "content.js", "storage.js", "options.html", "options.css", "options.js"]) {
  assert.doesNotMatch(read(file), /[\u3400-\u9fff]/, `${file} contains non-English product text`);
}

const readme = read("README.md");
assert.match(readme, /<details>/);
assert.match(readme, /简体中文/);
assert.match(readme, /## 安装/);
assert.match(readme, /## Install/);

console.log("Verification passed.");
console.log(`Fixed extension ID: ${extensionId}`);
console.log(`UTF-16 category size: ${store.estimateCategoryBytes(category).bytes} bytes`);
