/* English Options UI for Prompt paste. */
(() => {
  "use strict";

  const elements = {
    syncButton: document.querySelector("#syncButton"),
    pullButton: document.querySelector("#pullButton"),
    retryButton: document.querySelector("#retryButton"),
    gcButton: document.querySelector("#gcButton"),
    storageNumber: document.querySelector("#storageNumber"),
    globalProgress: document.querySelector("#globalProgress"),
    actualBar: document.querySelector("#actualBar"),
    projectedBar: document.querySelector("#projectedBar"),
    actualLegend: document.querySelector("#actualLegend"),
    projectedLegend: document.querySelector("#projectedLegend"),
    itemUsage: document.querySelector("#itemUsage"),
    tombstoneUsage: document.querySelector("#tombstoneUsage"),
    localUsage: document.querySelector("#localUsage"),
    pendingUsage: document.querySelector("#pendingUsage"),
    lastSync: document.querySelector("#lastSync"),
    lastGc: document.querySelector("#lastGc"),
    statusBanner: document.querySelector("#statusBanner"),
    categoryForm: document.querySelector("#categoryForm"),
    categoryName: document.querySelector("#categoryName"),
    categoryList: document.querySelector("#categoryList"),
    categoryCount: document.querySelector("#categoryCount"),
    emptyState: document.querySelector("#emptyState"),
    categoryEditor: document.querySelector("#categoryEditor"),
    selectedCategoryName: document.querySelector("#selectedCategoryName"),
    selectedCategoryMeta: document.querySelector("#selectedCategoryMeta"),
    renameCategoryButton: document.querySelector("#renameCategoryButton"),
    deleteCategoryButton: document.querySelector("#deleteCategoryButton"),
    addPromptButton: document.querySelector("#addPromptButton"),
    promptList: document.querySelector("#promptList"),
    conflictCard: document.querySelector("#conflictCard"),
    keepLocalButton: document.querySelector("#keepLocalButton"),
    acceptDeleteButton: document.querySelector("#acceptDeleteButton"),
    promptTemplate: document.querySelector("#promptTemplate"),
    toast: document.querySelector("#toast")
  };

  let state = null;
  let selectedCategoryId = null;
  let showNewPrompt = false;
  let editingPromptId = null;
  let busyCount = 0;
  let toastTimer = null;
  let reloadTimer = null;
  let pendingExternalReload = false;
  let stateRequestVersion = 0;
  const promptDrafts = new Map();

  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw new Error(response?.error || "The extension did not return a valid response.");
    return response.data;
  }

  function ignoreHandledError(promise) {
    void promise.catch(() => undefined);
  }

  function setBusy(isBusy) {
    busyCount += isBusy ? 1 : -1;
    busyCount = Math.max(0, busyCount);
    for (const button of document.querySelectorAll("button")) button.disabled = busyCount > 0;
  }

  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("is-error", isError);
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
  }

  async function perform(action, successMessage) {
    stateRequestVersion += 1;
    setBusy(true);
    try {
      const result = await action();
      if (result?.categories) {
        stateRequestVersion += 1;
        state = result;
      }
      else await loadState();
      if (successMessage) showToast(successMessage);
      render();
      return result;
    } catch (error) {
      showToast(error.message, true);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function loadState() {
    const requestVersion = ++stateRequestVersion;
    const nextState = await send("GET_STATE");
    if (requestVersion !== stateRequestVersion) return;
    state = nextState;
    pendingExternalReload = false;
    const active = getActiveCategories();
    if (!active.some((category) => category.id === selectedCategoryId)) {
      selectedCategoryId = active[0]?.id || null;
    }
    render();
  }

  function getActiveCategories() {
    if (!state) return [];
    return state.categories.filter((category) => !category.deleted).sort((a, b) => a.createdAt - b.createdAt);
  }

  function selectedCategory() {
    return getActiveCategories().find((category) => category.id === selectedCategoryId) || null;
  }

  function draftKey(categoryId, promptId) {
    return `${categoryId}:${promptId || "new"}`;
  }

  function clearCategoryDrafts(categoryId) {
    for (const key of promptDrafts.keys()) {
      if (key.startsWith(`${categoryId}:`)) promptDrafts.delete(key);
    }
  }

  function dateLabel(timestamp) {
    if (!timestamp) return "Not yet";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(timestamp));
  }

  function usageClass(percent) {
    if (percent >= 95) return "usage-critical";
    if (percent >= 80) return "usage-high";
    if (percent >= 60) return "usage-medium";
    return "";
  }

  function renderStorage() {
    const usage = state.usage;
    const quotas = state.quotas;
    const available = Math.max(0, quotas.syncBytes - usage.syncBytes);
    const actualPercent = Math.min(100, usage.syncBytes / quotas.syncBytes * 100);
    const projectedPercent = Math.min(100, usage.projectedSyncBytes / quotas.syncBytes * 100);
    elements.storageNumber.textContent = `${PromptStore.formatBytes(usage.syncBytes)} used · ${PromptStore.formatBytes(available)} available`;
    elements.actualBar.style.width = `${actualPercent}%`;
    elements.projectedBar.style.width = `${projectedPercent}%`;
    elements.actualLegend.textContent = PromptStore.formatBytes(usage.syncBytes);
    elements.projectedLegend.textContent = PromptStore.formatBytes(usage.projectedSyncBytes);
    elements.globalProgress.setAttribute("aria-valuemax", String(quotas.syncBytes));
    elements.globalProgress.setAttribute("aria-valuenow", String(usage.syncBytes));
    elements.globalProgress.title = `${usage.syncBytes.toLocaleString()} of ${quotas.syncBytes.toLocaleString()} bytes used`;
    elements.itemUsage.textContent = `${usage.syncItemCount} / ${quotas.syncItems}`;
    elements.tombstoneUsage.textContent = `${usage.tombstoneCount} · ${usage.eligibleTombstoneCount} ready`;
    elements.localUsage.textContent = `${PromptStore.formatBytes(usage.localBytes)} / ${PromptStore.formatBytes(quotas.localBytes)}`;
    elements.pendingUsage.textContent = String(Object.keys(state.meta.pendingByCategory).length);
    elements.lastSync.textContent = state.meta.lastSuccessfulSyncAt
      ? `${dateLabel(state.meta.lastSuccessfulSyncAt)} · ${state.meta.lastSyncDirection}`
      : "Not yet";
    elements.lastGc.textContent = state.meta.lastGcAt
      ? `${dateLabel(state.meta.lastGcAt)} · ${state.meta.lastGcRemovedCount} removed`
      : "Not yet";
    elements.statusBanner.hidden = !state.meta.lastSyncError;
    elements.statusBanner.textContent = state.meta.lastSyncError || "";
  }

  function categoryStatus(category) {
    const conflict = state.meta.gcConflicts[category.id];
    const pending = state.meta.pendingByCategory[category.id];
    if (conflict) return { className: "conflict", label: "Cloud deletion needs review" };
    if (pending?.status === "blocked") return { className: "blocked", label: pending.lastError || "Sync blocked" };
    if (pending) return { className: "pending", label: "Pending sync" };
    return { className: "", label: "Synced" };
  }

  function renderCategories() {
    const categories = getActiveCategories();
    elements.categoryCount.textContent = String(categories.length);
    elements.categoryList.replaceChildren();
    for (const category of categories) {
      const size = state.meta.sizeByCategory[category.id]?.estimatedSyncBytes
        ?? PromptStore.estimateCategoryBytes(category).bytes;
      const percent = Math.max(0, size / state.quotas.syncItemBytes * 100);
      const status = categoryStatus(category);
      const row = document.createElement("div");
      row.className = "category-row";
      row.classList.toggle("is-selected", category.id === selectedCategoryId);

      const select = document.createElement("button");
      select.type = "button";
      select.className = "category-select";
      select.addEventListener("click", () => {
        selectedCategoryId = category.id;
        showNewPrompt = false;
        editingPromptId = null;
        render();
      });

      const nameLine = document.createElement("span");
      nameLine.className = "category-name-line";
      const dot = document.createElement("i");
      dot.className = `status-dot ${status.className}`;
      dot.title = status.label;
      const name = document.createElement("span");
      name.className = "category-name";
      name.textContent = category.name;
      nameLine.append(dot, name);
      const sizeText = document.createElement("span");
      sizeText.className = "category-size";
      sizeText.textContent = `${PromptStore.formatBytes(size)} / ${PromptStore.formatBytes(state.quotas.syncItemBytes)} · ${status.label}`;
      select.append(nameLine, sizeText);

      const tools = document.createElement("div");
      tools.className = "category-tools";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button";
      remove.textContent = "×";
      remove.title = "Delete category";
      remove.setAttribute("aria-label", `Delete ${category.name}`);
      remove.addEventListener("click", () => ignoreHandledError(requestDeleteCategory(category)));
      tools.append(remove);

      const progress = document.createElement("div");
      progress.className = "category-progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", `${category.name} Sync item usage`);
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", String(state.quotas.syncItemBytes));
      progress.setAttribute("aria-valuenow", String(size));
      progress.title = `${size.toLocaleString()} bytes (${percent.toFixed(1)}%)`;
      const fill = document.createElement("div");
      fill.className = `category-progress-fill ${usageClass(percent)}`;
      fill.style.width = `${Math.min(100, percent)}%`;
      progress.append(fill);
      row.append(select, tools, progress);
      elements.categoryList.append(row);
    }
  }

  function makePromptCard(prompt) {
    const card = elements.promptTemplate.content.firstElementChild.cloneNode(true);
    const summary = card.querySelector(".prompt-summary");
    const open = card.querySelector(".prompt-open");
    const summaryTitle = card.querySelector(".prompt-summary-title");
    const summaryPreview = card.querySelector(".prompt-summary-preview");
    const summarySize = card.querySelector(".prompt-summary-size");
    const edit = card.querySelector(".prompt-edit");
    const editor = card.querySelector(".prompt-editor");
    const title = card.querySelector(".prompt-title");
    const content = card.querySelector(".prompt-content");
    const save = card.querySelector(".prompt-save");
    const cancel = card.querySelector(".prompt-cancel");
    const remove = card.querySelector(".prompt-delete");
    const size = card.querySelector(".prompt-size");
    const key = draftKey(selectedCategoryId, prompt?.id);
    const draft = promptDrafts.get(key);
    const isNew = !prompt;
    const isEditing = isNew || editingPromptId === prompt.id;
    const contentBytes = new TextEncoder().encode(prompt?.content || "").byteLength;

    card.dataset.promptId = prompt?.id || "new";
    card.classList.toggle("is-new", isNew);
    card.classList.toggle("is-editing", isEditing);
    summary.hidden = isEditing;
    editor.hidden = !isEditing;
    open.setAttribute("aria-expanded", String(isEditing));
    summaryTitle.textContent = prompt?.title || "New Prompt";
    summaryPreview.textContent = String(prompt?.content || "")
      .replace(/\s+/g, " ")
      .trim() || "Empty Prompt";
    summarySize.textContent = PromptStore.formatBytes(contentBytes);
    title.value = draft?.title ?? prompt?.title ?? "";
    content.value = draft?.content ?? prompt?.content ?? "";
    size.textContent = prompt
      ? `${PromptStore.formatBytes(contentBytes)} uncompressed`
      : "New Prompt";
    save.textContent = prompt ? "Save changes" : "Add Prompt";
    const rememberDraft = () => {
      promptDrafts.set(key, { title: title.value, content: content.value });
      size.textContent = `${PromptStore.formatBytes(new TextEncoder().encode(content.value).byteLength)} uncompressed`;
    };
    title.addEventListener("input", rememberDraft);
    content.addEventListener("input", rememberDraft);

    if (prompt) {
      const beginEditing = () => {
        showNewPrompt = false;
        editingPromptId = prompt.id;
        renderEditor();
        elements.promptList
          .querySelector(`[data-prompt-id="${CSS.escape(prompt.id)}"] .prompt-title`)
          ?.focus();
      };
      open.addEventListener("click", beginEditing);
      edit.addEventListener("click", beginEditing);
      remove.addEventListener("click", () => ignoreHandledError(requestDeletePrompt(prompt)));
    }

    save.addEventListener("click", () => ignoreHandledError(savePrompt(prompt?.id, title.value, content.value)));
    cancel.addEventListener("click", () => {
      promptDrafts.delete(key);
      if (isNew) showNewPrompt = false;
      else editingPromptId = null;
      renderEditor();
    });
    return card;
  }

  function renderEditor() {
    const category = selectedCategory();
    elements.emptyState.hidden = Boolean(category);
    elements.categoryEditor.hidden = !category;
    if (!category) return;

    const status = categoryStatus(category);
    const size = state.meta.sizeByCategory[category.id]?.estimatedSyncBytes
      ?? PromptStore.estimateCategoryBytes(category).bytes;
    elements.selectedCategoryName.textContent = category.name;
    elements.selectedCategoryMeta.textContent = `${category.prompts.length} Prompt${category.prompts.length === 1 ? "" : "s"} · ${PromptStore.formatBytes(size)} compressed · ${status.label}`;
    elements.conflictCard.hidden = !state.meta.gcConflicts[category.id];
    elements.promptList.replaceChildren();
    if (editingPromptId && !category.prompts.some((prompt) => prompt.id === editingPromptId)) {
      editingPromptId = null;
    }
    if (showNewPrompt) elements.promptList.append(makePromptCard(null));
    for (const prompt of [...category.prompts].sort((a, b) => a.createdAt - b.createdAt)) {
      elements.promptList.append(makePromptCard(prompt));
    }
    if (!showNewPrompt && !category.prompts.length) {
      const note = document.createElement("div");
      note.className = "empty-state";
      note.style.minHeight = "340px";
      const heading = document.createElement("h2");
      heading.textContent = "No Prompts in this category";
      const copy = document.createElement("p");
      copy.textContent = "Add a Prompt, then right-click any editable field to paste it.";
      note.append(heading, copy);
      elements.promptList.append(note);
    }
  }

  function render() {
    if (!state) return;
    renderStorage();
    renderCategories();
    renderEditor();
  }

  async function savePrompt(promptId, title, content) {
    await perform(
      () => send("UPSERT_PROMPT", { categoryId: selectedCategoryId, promptId, title, content }),
      promptId ? "Prompt updated." : "Prompt added."
    );
    promptDrafts.delete(draftKey(selectedCategoryId, promptId));
    showNewPrompt = false;
    editingPromptId = null;
    renderEditor();
  }

  async function requestDeletePrompt(prompt) {
    if (!confirm(`Delete the Prompt “${prompt.title}”?`)) return;
    await perform(
      () => send("DELETE_PROMPT", { categoryId: selectedCategoryId, promptId: prompt.id }),
      "Prompt deleted."
    );
    promptDrafts.delete(draftKey(selectedCategoryId, prompt.id));
    if (editingPromptId === prompt.id) editingPromptId = null;
  }

  async function requestDeleteCategory(category) {
    if (!confirm(`Delete the category “${category.name}” and all of its Prompts?`)) return;
    if (selectedCategoryId === category.id) selectedCategoryId = null;
    editingPromptId = null;
    showNewPrompt = false;
    clearCategoryDrafts(category.id);
    await perform(() => send("DELETE_CATEGORY", { categoryId: category.id }), "Category deleted.");
  }

  elements.categoryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = elements.categoryName.value;
    // Keep post-submit selection in the same awaited task. The old Promise
    // continuation performed a second, delayed render after buttons became
    // interactive; a quick click on Add Prompt could then have its focused
    // input replaced by that late render.
    ignoreHandledError((async () => {
      const nextState = await perform(
        () => send("ADD_CATEGORY", { name }),
        "Category added."
      );
      elements.categoryName.value = "";
      const categories = nextState.categories
        .filter((category) => !category.deleted)
        .sort((left, right) => left.createdAt - right.createdAt);
      selectedCategoryId = categories[categories.length - 1]?.id || selectedCategoryId;
      editingPromptId = null;
      showNewPrompt = false;
      render();
    })());
  });

  elements.renameCategoryButton.addEventListener("click", () => {
    const category = selectedCategory();
    if (!category) return;
    const name = prompt("Rename category", category.name);
    if (name === null || name === category.name) return;
    ignoreHandledError(perform(() => send("RENAME_CATEGORY", { categoryId: category.id, name }), "Category renamed."));
  });

  elements.deleteCategoryButton.addEventListener("click", () => {
    const category = selectedCategory();
    if (category) ignoreHandledError(requestDeleteCategory(category));
  });

  elements.addPromptButton.addEventListener("click", () => {
    showNewPrompt = true;
    editingPromptId = null;
    renderEditor();
    elements.promptList.querySelector(".prompt-title")?.focus();
  });

  elements.syncButton.addEventListener("click", () => {
    if (!confirm("Replace the cloud copy with this device’s complete local library?")) return;
    ignoreHandledError(perform(() => send("FORCE_PUSH"), "Local library synced to the cloud."));
  });

  elements.pullButton.addEventListener("click", () => {
    if (!confirm("Replace this device’s local library with the cloud copy? Unsynced local changes will be lost.")) return;
    ignoreHandledError(perform(() => send("FORCE_PULL"), "Cloud library pulled to this device."));
  });

  elements.retryButton.addEventListener("click", () => {
    ignoreHandledError(perform(() => send("RETRY_PENDING"), "Pending changes were checked."));
  });

  elements.gcButton.addEventListener("click", () => {
    ignoreHandledError(perform(() => send("RUN_TOMBSTONE_GC"), "Expired tombstones were checked."));
  });

  elements.keepLocalButton.addEventListener("click", () => {
    ignoreHandledError(perform(
      () => send("RESOLVE_GC_CONFLICT_KEEP_LOCAL", { categoryId: selectedCategoryId }),
      "Local category restored to the cloud."
    ));
  });

  elements.acceptDeleteButton.addEventListener("click", () => {
    if (!confirm("Accept the cloud deletion and permanently remove this device’s offline copy?")) return;
    const categoryId = selectedCategoryId;
    selectedCategoryId = null;
    ignoreHandledError(perform(
      () => send("RESOLVE_GC_CONFLICT_ACCEPT_DELETE", { categoryId }),
      "Cloud deletion accepted."
    ));
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !Object.keys(changes).some((key) =>
      key === PromptStore.LOCAL_META_KEY || key.startsWith(PromptStore.LOCAL_CATEGORY_PREFIX)
    )) return;
    const active = document.activeElement;
    const userIsEditing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (userIsEditing || busyCount > 0) {
      pendingExternalReload = true;
      return;
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      // Focus may have moved into an editor after this reload was scheduled.
      // Re-check at execution time so an older storage event cannot replace a
      // newly focused input or textarea.
      const current = document.activeElement;
      const editingNow = current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement;
      if (editingNow || busyCount > 0) {
        pendingExternalReload = true;
        return;
      }
      void loadState().catch((error) => showToast(error.message, true));
    }, 180);
  });

  document.addEventListener("focusout", () => {
    if (!pendingExternalReload) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      const active = document.activeElement;
      const userIsEditing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (userIsEditing || busyCount > 0) return;
      void loadState().catch((error) => showToast(error.message, true));
    }, 120);
  });

  void loadState().catch((error) => showToast(error.message, true));
})();
