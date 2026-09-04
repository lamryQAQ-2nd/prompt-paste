(async () => {
  "use strict";

  const textInputTypes = new Set([
    "text", "search", "email", "url", "tel", "password"
  ]);

  const deepestActiveElement = (rootDocument) => {
    let active = rootDocument.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };

  const editableTarget = (active) => {
    if (!active) return null;
    if (active instanceof HTMLTextAreaElement) return active;
    if (active instanceof HTMLInputElement && textInputTypes.has(active.type)) return active;
    if (active.isContentEditable) return active;
    return active.closest?.('[contenteditable="true"], [contenteditable="plaintext-only"]') || null;
  };

  const target = editableTarget(deepestActiveElement(document));
  const selection = window.getSelection();
  const savedRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const savedInputSelection = target && "selectionStart" in target
    ? { start: target.selectionStart, end: target.selectionEnd }
    : null;

  const response = await chrome.runtime.sendMessage({ type: "CLAIM_INSERT_REQUEST" });
  if (!response?.ok) return { ok: false, code: "REQUEST_FAILED", error: response?.error };
  const promptText = String(response.data.promptText ?? "").replace(/\r\n?/g, "\n");
  if (!target) return { ok: false, code: "NO_EDITABLE_TARGET" };

  target.focus({ preventScroll: true });
  const focused = deepestActiveElement(document);
  if (focused !== target && !target.contains?.(focused)) {
    return { ok: false, code: "FOCUS_RESTORE_FAILED" };
  }

  if (savedInputSelection && typeof target.setSelectionRange === "function") {
    target.setSelectionRange(savedInputSelection.start, savedInputSelection.end);
  } else if (savedRange && target.contains(savedRange.commonAncestorContainer)) {
    const restored = window.getSelection();
    restored.removeAllRanges();
    restored.addRange(savedRange);
  }

  const beforeValue = "value" in target ? target.value : target.textContent;
  const beforeSelectionStart = "selectionStart" in target ? target.selectionStart : null;
  let nativeResult = false;
  try {
    nativeResult = document.execCommand("insertText", false, promptText);
  } catch {
    nativeResult = false;
  }
  const afterValue = "value" in target ? target.value : target.textContent;
  const afterSelectionStart = "selectionStart" in target ? target.selectionStart : null;
  const nativeChanged = nativeResult || afterValue !== beforeValue || afterSelectionStart !== beforeSelectionStart;
  if (nativeChanged) return { ok: true, strategy: "execCommand" };

  const makeInputEvent = (type, cancelable) => new InputEvent(type, {
    bubbles: true,
    cancelable,
    composed: true,
    inputType: "insertText",
    data: promptText
  });

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const beforeInput = makeInputEvent("beforeinput", true);
    if (!target.dispatchEvent(beforeInput)) return { ok: false, code: "INSERT_CANCELLED" };
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(promptText, start, end, "end");
    target.dispatchEvent(makeInputEvent("input", false));
    return { ok: true, strategy: "setRangeText" };
  }

  const currentSelection = window.getSelection();
  if (!currentSelection?.rangeCount) return { ok: false, code: "NO_SELECTION" };
  const range = currentSelection.getRangeAt(0);
  if (!target.contains(range.commonAncestorContainer)) return { ok: false, code: "SELECTION_OUTSIDE_EDITOR" };
  const beforeInput = makeInputEvent("beforeinput", true);
  if (!target.dispatchEvent(beforeInput)) return { ok: false, code: "INSERT_CANCELLED" };
  range.deleteContents();
  const textNode = document.createTextNode(promptText);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  currentSelection.removeAllRanges();
  currentSelection.addRange(range);
  target.dispatchEvent(makeInputEvent("input", false));
  return { ok: true, strategy: "range" };
})();
