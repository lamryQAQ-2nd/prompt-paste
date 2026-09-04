import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.dirname(testDir);
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "prompte-paste-cdp-"));
const browser = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profilePath}`,
  "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging",
  "about:blank"
], {
  stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
});

let nextId = 1;
let buffer = Buffer.alloc(0);
const pending = new Map();
const events = [];

browser.stdio[4].on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let separator;
  while ((separator = buffer.indexOf(0)) >= 0) {
    const raw = buffer.subarray(0, separator).toString("utf8");
    buffer = buffer.subarray(separator + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (!message.id) {
      events.push(message);
      continue;
    }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});

function command(method, params = {}, sessionId = undefined) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  browser.stdio[3].write(`${JSON.stringify(message)}\0`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 10000);
    pending.set(id, {
      resolve(value) { clearTimeout(timeout); resolve(value); },
      reject(error) { clearTimeout(timeout); reject(error); }
    });
  });
}

try {
  const loaded = await command("Extensions.loadUnpacked", { path: extensionPath });
  const extensionId = loaded.id || loaded.extensionId;
  assert.equal(extensionId, "ggdjhafkodfdkdpjfiiaghedigdbdgpi");

  const created = await command("Target.createTarget", {
    url: `chrome-extension://${extensionId}/options.html`
  });
  const attached = await command("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true
  });
  await command("Runtime.enable", {}, attached.sessionId);
  await command("Page.enable", {}, attached.sessionId);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  }, attached.sessionId);
  await command("Page.reload", {}, attached.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 700));

  const evaluated = await command("Runtime.evaluate", {
    expression: `({
      title: document.title,
      readyState: document.readyState,
      extensionId: chrome.runtime.id,
      heading: document.querySelector('h1')?.textContent,
      brandIconLoaded: document.querySelector('.brand-mark')?.complete &&
        document.querySelector('.brand-mark')?.naturalWidth === 48,
      bodyText: document.body.innerText
    })`,
    returnByValue: true
  }, attached.sessionId);
  const page = evaluated.result.value;
  assert.equal(page.title, "Prompt paste");
  assert.equal(page.readyState, "complete");
  assert.equal(page.extensionId, extensionId);
  assert.equal(page.heading, "Prompt paste");
  assert.equal(page.brandIconLoaded, true);
  assert.match(page.bodyText, /Sync storage/);

  const initialVisibility = await command("Runtime.evaluate", {
    expression: `({
      emptyHidden: document.querySelector("#emptyState").hidden,
      emptyDisplay: getComputedStyle(document.querySelector("#emptyState")).display,
      editorHidden: document.querySelector("#categoryEditor").hidden,
      editorDisplay: getComputedStyle(document.querySelector("#categoryEditor")).display,
      conflictHidden: document.querySelector("#conflictCard").hidden,
      conflictDisplay: getComputedStyle(document.querySelector("#conflictCard")).display
    })`,
    returnByValue: true
  }, attached.sessionId);
  assert.deepEqual(initialVisibility.result.value, {
    emptyHidden: false,
    emptyDisplay: "grid",
    editorHidden: true,
    editorDisplay: "none",
    conflictHidden: true,
    conflictDisplay: "none"
  });

  const response = await command("Runtime.evaluate", {
    expression: `chrome.runtime.sendMessage({type: 'GET_STATE'})`,
    awaitPromise: true,
    returnByValue: true
  }, attached.sessionId);
  assert.equal(response.result.value.ok, true);
  assert.ok(response.result.value.data.quotas.syncItemBytes >= 8192);

  // Exercise the real Options page rather than only the message API. A prior
  // GET_STATE implementation wrote metadata while reading it, which caused an
  // endless storage-change/render loop and stole focus from these controls.
  const editorFlow = await command("Runtime.evaluate", {
    expression: `(async () => {
      const waitFor = async (predicate, timeout = 5000) => {
        const started = Date.now();
        while (!predicate()) {
          if (Date.now() - started > timeout) throw new Error("UI condition timed out.");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const categoryInput = document.querySelector("#categoryName");
      categoryInput.value = "Focus regression";
      categoryInput.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#categoryForm").requestSubmit();
      await waitFor(() => document.querySelector("#selectedCategoryName")?.textContent === "Focus regression");
      document.querySelector("#addPromptButton").click();
      const title = document.querySelector(".prompt-title");
      title.focus();
      title.value = "Right-click Prompt";
      title.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const titleFocusStayed = document.activeElement === title;
      const titleValueStayed = title.value === "Right-click Prompt";
      const titleNodeStayed = title.isConnected && document.querySelector(".prompt-title") === title;
      const content = document.querySelector(".prompt-content");
      content.focus();
      content.value = "Inserted from the context menu";
      content.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const contentFocusStayed = document.activeElement === content;
      const contentValueStayed = content.value === "Inserted from the context menu";
      document.querySelector(".prompt-save").click();
      await waitFor(() => document.querySelector("#selectedCategoryMeta")?.textContent.startsWith("1 Prompt"));
      const savedState = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      const category = savedState.data.categories.find((item) => item.name === "Focus regression");
      const compactCard = document.querySelector(".prompt-card");
      const compactHeight = compactCard.getBoundingClientRect().height;
      const compactSummaryVisible = !compactCard.querySelector(".prompt-summary").hidden;
      const compactEditorHidden = compactCard.querySelector(".prompt-editor").hidden;
      compactCard.querySelector(".prompt-edit").click();
      const expandedCard = document.querySelector(".prompt-card");
      const expandedSummaryHidden = expandedCard.querySelector(".prompt-summary").hidden;
      const expandedEditorVisible = !expandedCard.querySelector(".prompt-editor").hidden;
      expandedCard.querySelector(".prompt-cancel").click();
      const collapsedAgain = document.querySelector(".prompt-card");
      document.querySelector("#addPromptButton").click();
      const cardsWithNew = [...document.querySelectorAll(".prompt-card")];
      const onlyNewEditorExpanded = cardsWithNew.length === 2 &&
        cardsWithNew[0].classList.contains("is-new") &&
        !cardsWithNew[0].querySelector(".prompt-editor").hidden &&
        !cardsWithNew[1].querySelector(".prompt-summary").hidden &&
        cardsWithNew[1].querySelector(".prompt-editor").hidden;
      cardsWithNew[0].querySelector(".prompt-cancel").click();
      return {
        titleFocusStayed,
        titleValueStayed,
        titleNodeStayed,
        contentFocusStayed,
        contentValueStayed,
        promptCount: category?.prompts.length,
        conflict: Boolean(savedState.data.meta.gcConflicts[category?.id]),
        status: document.querySelector("#selectedCategoryMeta")?.textContent,
        emptyHidden: document.querySelector("#emptyState").hidden,
        emptyDisplay: getComputedStyle(document.querySelector("#emptyState")).display,
        editorHidden: document.querySelector("#categoryEditor").hidden,
        editorDisplay: getComputedStyle(document.querySelector("#categoryEditor")).display,
        conflictHidden: document.querySelector("#conflictCard").hidden,
        conflictDisplay: getComputedStyle(document.querySelector("#conflictCard")).display,
        compactHeight,
        compactSummaryVisible,
        compactEditorHidden,
        expandedSummaryHidden,
        expandedEditorVisible,
        collapsedAgain: !collapsedAgain.querySelector(".prompt-summary").hidden &&
          collapsedAgain.querySelector(".prompt-editor").hidden,
        onlyNewEditorExpanded
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  }, attached.sessionId);
  assert.equal(Boolean(editorFlow.exceptionDetails), false);
  assert.equal(editorFlow.result.value.titleFocusStayed, true);
  assert.equal(editorFlow.result.value.titleValueStayed, true);
  assert.equal(editorFlow.result.value.titleNodeStayed, true);
  assert.equal(editorFlow.result.value.contentFocusStayed, true);
  assert.equal(editorFlow.result.value.contentValueStayed, true);
  assert.equal(editorFlow.result.value.promptCount, 1);
  assert.equal(editorFlow.result.value.conflict, false);
  assert.match(editorFlow.result.value.status, /^1 Prompt/);
  assert.equal(editorFlow.result.value.emptyHidden, true);
  assert.equal(editorFlow.result.value.emptyDisplay, "none");
  assert.equal(editorFlow.result.value.editorHidden, false);
  assert.notEqual(editorFlow.result.value.editorDisplay, "none");
  assert.equal(editorFlow.result.value.conflictHidden, true);
  assert.equal(editorFlow.result.value.conflictDisplay, "none");
  assert.ok(editorFlow.result.value.compactHeight <= 80);
  assert.equal(editorFlow.result.value.compactSummaryVisible, true);
  assert.equal(editorFlow.result.value.compactEditorHidden, true);
  assert.equal(editorFlow.result.value.expandedSummaryHidden, true);
  assert.equal(editorFlow.result.value.expandedEditorVisible, true);
  assert.equal(editorFlow.result.value.collapsedAgain, true);
  assert.equal(editorFlow.result.value.onlyNewEditorExpanded, true);

  const contentSource = fs.readFileSync(path.join(extensionPath, "content.js"), "utf8");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const injection = await command("Runtime.evaluate", {
      expression: contentSource,
      awaitPromise: true,
      returnByValue: true
    }, attached.sessionId);
    assert.equal(Boolean(injection.exceptionDetails), false);
  }
  const leaked = await command("Runtime.evaluate", {
    expression: `Object.getOwnPropertyNames(globalThis).filter((key) => /^(?:__)?prompte|promptePaste/i.test(key))`,
    returnByValue: true
  }, attached.sessionId);
  assert.deepEqual(leaked.result.value, []);

  const exceptions = events.filter((event) => event.method === "Runtime.exceptionThrown");
  assert.deepEqual(exceptions, []);
  if (process.env.SCREENSHOT_PATH) {
    const screenshot = await command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true
    }, attached.sessionId);
    fs.writeFileSync(process.env.SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
  }
  console.log("Real Chrome CDP smoke test passed.");
  console.log(`Loaded extension ID: ${extensionId}`);
} finally {
  browser.kill("SIGTERM");
  await new Promise((resolve) => {
    const fallback = setTimeout(resolve, 2000);
    browser.once("exit", () => { clearTimeout(fallback); resolve(); });
  });
  fs.rmSync(profilePath, { recursive: true, force: true });
}
