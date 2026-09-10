(() => {
  "use strict";

  const DEBUG = false;
  const SETTING_KEY = "jiraStandupOrderLocker.expandBoardAssigneeFilters";
  const ROW_ID = "jira-standup-locker-assignee-row";
  const STYLE_ID = "jira-standup-locker-assignee-row-styles";
  const NATIVE_FILTER_ATTRIBUTE = "data-jira-standup-locker-native-assignee-filter";
  const LAYOUT_ATTRIBUTE = "data-jira-standup-locker-assignee-layout";
  const MENU_HIDDEN_ATTRIBUTE = "data-jira-standup-locker-assignee-menu-hidden";
  const MUTATION_DEBOUNCE_MS = 180;
  const MENU_RENDER_TIMEOUT_MS = 1600;

  const SELECTORS = {
    assigneeFilter: [
      '[data-testid="filters.ui.filters.assignee.stateless.assignee-filter"]',
      '[data-test-id="filters.ui.filters.assignee.stateless.assignee-filter"]'
    ],
    controlsBar: [
      '[data-testid="software-board.header.controls-bar"]',
      '[data-test-id="software-board.header.controls-bar"]'
    ],
    showMoreButton: [
      '[data-testid="filters.ui.filters.assignee.stateless.show-more-button.assignee-filter-show-more"]',
      '[data-test-id="filters.ui.filters.assignee.stateless.show-more-button.assignee-filter-show-more"]'
    ]
  };

  const state = {
    timer: 0,
    running: false,
    queued: false,
    boardPath: "",
    sourceSignature: "",
    assignees: [],
    activeFieldset: null,
    enabled: false
  };

  const log = (...args) => {
    if (DEBUG) {
      console.debug("[Jira Standup Locker: Assignees]", ...args);
    }
  };

  const queryFirst = (root, selectors) => {
    for (const selector of selectors) {
      const match = root.querySelector(selector);
      if (match) {
        return match;
      }
    }
    return null;
  };

  const delay = (milliseconds) => {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  };

  const normalizeText = (value) => {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  };

  const isJiraBoardPath = () => {
    return /\/jira\/software\/c\/projects\/[^/]+\/boards\/\d+/.test(location.pathname);
  };

  const findAssigneeFilter = () => {
    const byTestId = queryFirst(document, SELECTORS.assigneeFilter);
    if (byTestId) {
      return byTestId;
    }

    const input = document.querySelector('input[name="assignee"][type="checkbox"][aria-label]');
    return input?.closest("fieldset") ?? null;
  };

  const findControlsBar = (fieldset) => {
    for (const selector of SELECTORS.controlsBar) {
      const match = fieldset.closest(selector);
      if (match) {
        return match;
      }
    }
    return null;
  };

  const findShowMoreButton = (fieldset) => {
    const byTestId = queryFirst(fieldset, SELECTORS.showMoreButton);
    if (byTestId) {
      return byTestId;
    }

    return Array.from(fieldset.querySelectorAll("button")).find((button) => {
      return /^\+\d+$/.test(normalizeText(button.textContent));
    }) ?? null;
  };

  const nameFromInput = (input) => {
    const label = normalizeText(input.getAttribute("aria-label"));
    const withoutPrefix = label
      .replace(/^Filter assignees by\s+/i, "")
      .replace(/^Filter by assignee\s+/i, "");

    if (withoutPrefix && withoutPrefix !== label) {
      return withoutPrefix;
    }

    const imageLabel = normalizeText(
      input.parentElement?.querySelector("img[alt], img[aria-label]")?.getAttribute("alt") ||
      input.parentElement?.querySelector("img[aria-label]")?.getAttribute("aria-label")
    );
    return imageLabel || label;
  };

  const imageSourceWithin = (element) => {
    const image = element?.querySelector("img");
    return image?.currentSrc || image?.getAttribute("src") || "";
  };

  const collectVisibleAssignees = (fieldset) => {
    return Array.from(
      fieldset.querySelectorAll('input[name="assignee"][type="checkbox"]')
    ).map((input) => {
      return {
        key: input.id || nameFromInput(input),
        name: nameFromInput(input),
        imageSrc: imageSourceWithin(input.parentElement),
        selected: input.checked,
        native: true
      };
    }).filter((assignee) => assignee.name);
  };

  const expectedHiddenCount = (showMoreButton) => {
    const match = normalizeText(showMoreButton?.textContent).match(/^\+(\d+)$/);
    return match ? Number(match[1]) : 0;
  };

  const getRenderedMenuItems = () => {
    return Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && normalizeText(item.textContent);
    });
  };

  const waitForMenuItems = async (minimumCount) => {
    const deadline = Date.now() + MENU_RENDER_TIMEOUT_MS;
    let items = [];

    while (Date.now() < deadline) {
      items = getRenderedMenuItems();
      if (items.length >= Math.max(1, minimumCount)) {
        return items;
      }
      await delay(40);
    }

    return items;
  };

  const closeAssigneeMenu = () => {
    const currentFilter = findAssigneeFilter();
    const currentButton = currentFilter ? findShowMoreButton(currentFilter) : null;
    if (currentButton?.getAttribute("aria-expanded") === "true") {
      currentButton.click();
    }
  };

  const readHiddenAssignees = async (fieldset, showMoreButton) => {
    // Do not take over a menu the user opened themselves. A later DOM mutation
    // will retry after it closes.
    if (showMoreButton.getAttribute("aria-expanded") === "true") {
      return null;
    }

    const previouslyFocused = document.activeElement;
    document.documentElement.setAttribute(MENU_HIDDEN_ATTRIBUTE, "true");

    try {
      showMoreButton.click();
      const items = await waitForMenuItems(expectedHiddenCount(showMoreButton));
      return items.map((item, index) => {
        const name = normalizeText(item.textContent);
        return {
          key: `overflow-${name || index}`,
          name,
          imageSrc: imageSourceWithin(item),
          selected: item.getAttribute("aria-checked") === "true",
          native: false
        };
      }).filter((assignee) => assignee.name);
    } finally {
      closeAssigneeMenu();
      await delay(0);
      document.documentElement.removeAttribute(MENU_HIDDEN_ATTRIBUTE);

      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    }
  };

  const sourceSignatureFor = (visibleAssignees, showMoreButton) => {
    return JSON.stringify({
      path: location.pathname,
      visible: visibleAssignees.map(({ key, name }) => [key, name]),
      hiddenCount: expectedHiddenCount(showMoreButton)
    });
  };

  const mergeAssignees = (visibleAssignees, hiddenAssignees) => {
    const merged = [];
    const names = new Set();

    for (const assignee of [...visibleAssignees, ...hiddenAssignees]) {
      const normalizedName = normalizeText(assignee.name).toLocaleLowerCase();
      if (!normalizedName || names.has(normalizedName)) {
        continue;
      }
      names.add(normalizedName);
      merged.push(assignee);
    }

    return merged;
  };

  const initialsFor = (name) => {
    if (/^unassigned$/i.test(name)) {
      return "–";
    }

    const parts = normalizeText(name).split(" ").filter(Boolean);
    if (parts.length === 0) {
      return "?";
    }

    const initials = parts.length === 1
      ? parts[0].slice(0, 2)
      : `${parts[0][0]}${parts[parts.length - 1][0]}`;
    return initials.toLocaleUpperCase();
  };

  const avatarColorFor = (name) => {
    const palette = [
      ["#CCE0FF", "#09326C"],
      ["#BAF3DB", "#164B35"],
      ["#FDD0EC", "#50253F"],
      ["#DFD8FD", "#352C63"],
      ["#F8E6A0", "#533F04"],
      ["#FEDEC8", "#5F3811"]
    ];
    let hash = 0;
    for (const character of name) {
      hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
    }
    return palette[hash % palette.length];
  };

  const createFallbackAvatar = (assignee) => {
    const fallback = document.createElement("span");
    fallback.className = "jira-standup-locker-assignee-initials";
    fallback.textContent = initialsFor(assignee.name);
    const [background, foreground] = avatarColorFor(assignee.name);
    fallback.style.backgroundColor = background;
    fallback.style.color = foreground;
    return fallback;
  };

  const createAvatar = (assignee) => {
    const avatar = document.createElement("span");
    avatar.className = "jira-standup-locker-assignee-avatar";

    if (!assignee.imageSrc) {
      avatar.appendChild(createFallbackAvatar(assignee));
      return avatar;
    }

    const image = document.createElement("img");
    image.alt = "";
    image.draggable = false;
    image.src = assignee.imageSrc;
    image.addEventListener("error", () => {
      image.remove();
      if (!avatar.firstChild) {
        avatar.appendChild(createFallbackAvatar(assignee));
      }
    }, { once: true });
    avatar.appendChild(image);
    return avatar;
  };

  const ensureStyles = () => {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${NATIVE_FILTER_ATTRIBUTE}] {
        display: none !important;
      }

      [${LAYOUT_ATTRIBUTE}] {
        height: auto !important;
      }

      html[${MENU_HIDDEN_ATTRIBUTE}] [role="menu"],
      html[${MENU_HIDDEN_ATTRIBUTE}] [role="menuitemcheckbox"] {
        visibility: hidden !important;
      }

      #${ROW_ID} {
        align-items: center;
        box-sizing: border-box;
        display: flex;
        flex: 0 0 auto;
        gap: 6px;
        margin-top: 8px;
        max-width: 100%;
        min-height: 36px;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 2px;
        scrollbar-color: var(--ds-border, #8590A2) transparent;
        scrollbar-width: thin;
        width: 100%;
      }

      #${ROW_ID}::-webkit-scrollbar {
        height: 6px;
      }

      #${ROW_ID}::-webkit-scrollbar-thumb {
        background: var(--ds-border, #8590A2);
        border-radius: 999px;
      }

      #${ROW_ID} .jira-standup-locker-assignee-button {
        align-items: center;
        appearance: none;
        background: transparent;
        border: 0;
        border-radius: 50%;
        box-sizing: border-box;
        cursor: pointer;
        display: inline-flex;
        flex: 0 0 32px;
        height: 32px;
        justify-content: center;
        margin: 0;
        outline: none;
        padding: 2px;
        position: relative;
        width: 32px;
      }

      #${ROW_ID} .jira-standup-locker-assignee-button::after {
        border: 2px solid transparent;
        border-radius: 50%;
        box-sizing: border-box;
        content: "";
        inset: 0;
        pointer-events: none;
        position: absolute;
      }

      #${ROW_ID} .jira-standup-locker-assignee-button:hover {
        background: var(--ds-background-neutral-hovered, rgba(9, 30, 66, 0.08));
      }

      #${ROW_ID} .jira-standup-locker-assignee-button[aria-pressed="true"]::after {
        border-color: var(--ds-border-selected, #0C66E4);
      }

      #${ROW_ID} .jira-standup-locker-assignee-button:focus-visible {
        box-shadow: 0 0 0 2px var(--ds-border-focused, #388BFF);
      }

      #${ROW_ID} .jira-standup-locker-assignee-button:disabled {
        cursor: wait;
        opacity: 0.65;
      }

      #${ROW_ID} .jira-standup-locker-assignee-avatar,
      #${ROW_ID} .jira-standup-locker-assignee-avatar > img,
      #${ROW_ID} .jira-standup-locker-assignee-initials {
        border-radius: 50%;
        display: block;
        height: 28px;
        width: 28px;
      }

      #${ROW_ID} .jira-standup-locker-assignee-avatar > img {
        object-fit: cover;
      }

      #${ROW_ID} .jira-standup-locker-assignee-initials {
        align-items: center;
        display: flex;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 600;
        justify-content: center;
        line-height: 1;
        user-select: none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };

  const findVisibleInputByName = (fieldset, name) => {
    return Array.from(
      fieldset.querySelectorAll('input[name="assignee"][type="checkbox"]')
    ).find((input) => nameFromInput(input) === name) ?? null;
  };

  const setCachedSelectedState = (name, selected) => {
    const cached = state.assignees.find((assignee) => assignee.name === name);
    if (cached) {
      cached.selected = selected;
    }
  };

  const toggleNativeAssignee = async (fieldset, name) => {
    const input = findVisibleInputByName(fieldset, name);
    if (input) {
      if (input.disabled || input.getAttribute("aria-disabled") === "true") {
        return null;
      }

      const previouslySelected = input.checked;
      input.click();
      await delay(50);
      const currentFilter = findAssigneeFilter();
      const currentInput = currentFilter
        ? findVisibleInputByName(currentFilter, name)
        : null;
      return currentInput?.checked ?? !previouslySelected;
    }

    const showMoreButton = findShowMoreButton(fieldset);
    if (!showMoreButton || showMoreButton.getAttribute("aria-expanded") === "true") {
      return null;
    }

    document.documentElement.setAttribute(MENU_HIDDEN_ATTRIBUTE, "true");
    try {
      showMoreButton.click();
      const items = await waitForMenuItems(expectedHiddenCount(showMoreButton));
      const menuItem = items.find((item) => normalizeText(item.textContent) === name);
      if (!menuItem || menuItem.getAttribute("aria-disabled") === "true") {
        return null;
      }

      const selected = menuItem.getAttribute("aria-checked") !== "true";
      menuItem.click();
      await delay(50);
      return selected;
    } finally {
      closeAssigneeMenu();
      await delay(0);
      document.documentElement.removeAttribute(MENU_HIDDEN_ATTRIBUTE);
    }
  };

  const onRowClick = async (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("button[data-assignee-name]")
      : null;
    if (!button || button.disabled) {
      return;
    }

    const name = button.dataset.assigneeName;
    const previousSelected = button.getAttribute("aria-pressed") === "true";
    button.disabled = true;

    try {
      const fieldset = findAssigneeFilter();
      const selected = fieldset ? await toggleNativeAssignee(fieldset, name) : null;
      if (selected === null) {
        button.setAttribute("aria-pressed", String(previousSelected));
        return;
      }

      button.setAttribute("aria-pressed", String(selected));
      setCachedSelectedState(name, selected);
    } finally {
      button.disabled = false;
      if (button.isConnected) {
        button.focus({ preventScroll: true });
      }
      scheduleEnhancement("assignee toggled");
    }
  };

  const onRowWheel = (event) => {
    const row = event.currentTarget;
    if (row.scrollWidth <= row.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
      return;
    }

    event.preventDefault();
    row.scrollLeft += event.deltaY;
  };

  const createRow = () => {
    const row = document.createElement("div");
    row.id = ROW_ID;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Filter by assignee");
    row.addEventListener("click", onRowClick);
    row.addEventListener("wheel", onRowWheel, { passive: false });
    return row;
  };

  const clearLayoutMarkers = (except = {}) => {
    for (const fieldset of document.querySelectorAll(`[${NATIVE_FILTER_ATTRIBUTE}]`)) {
      if (fieldset !== except.fieldset) {
        fieldset.removeAttribute(NATIVE_FILTER_ATTRIBUTE);
      }
    }

    for (const element of document.querySelectorAll(`[${LAYOUT_ATTRIBUTE}]`)) {
      if (element !== except.host && element !== except.header) {
        element.removeAttribute(LAYOUT_ATTRIBUTE);
      }
    }
  };

  const renderRow = (fieldset, assignees, signature) => {
    const controlsBar = findControlsBar(fieldset);
    const host = controlsBar?.parentElement;
    const header = host?.parentElement;
    if (!controlsBar || !host || !header) {
      return false;
    }

    let row = document.getElementById(ROW_ID);
    if (row && row.parentElement !== host) {
      row.remove();
      row = null;
    }
    if (!row) {
      row = createRow();
      host.appendChild(row);
    }

    const previousScrollLeft = row.scrollLeft;
    row.replaceChildren();
    row.dataset.sourceSignature = signature;

    for (const assignee of assignees) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jira-standup-locker-assignee-button";
      button.dataset.assigneeName = assignee.name;
      button.setAttribute("aria-label", `Filter assignees by ${assignee.name}`);
      button.setAttribute("aria-pressed", String(Boolean(assignee.selected)));
      button.title = assignee.name;
      button.appendChild(createAvatar(assignee));
      row.appendChild(button);
    }

    row.scrollLeft = previousScrollLeft;
    fieldset.setAttribute(NATIVE_FILTER_ATTRIBUTE, "true");
    host.setAttribute(LAYOUT_ATTRIBUTE, "true");
    header.setAttribute(LAYOUT_ATTRIBUTE, "true");
    clearLayoutMarkers({ fieldset, host, header });
    state.activeFieldset = fieldset;
    return true;
  };

  const syncVisibleSelections = (fieldset) => {
    const row = document.getElementById(ROW_ID);
    if (!row) {
      return;
    }

    for (const visible of collectVisibleAssignees(fieldset)) {
      setCachedSelectedState(visible.name, visible.selected);
      const button = Array.from(row.querySelectorAll("button[data-assignee-name]")).find((candidate) => {
        return candidate.dataset.assigneeName === visible.name;
      });
      button?.setAttribute("aria-pressed", String(visible.selected));
    }
  };

  const cleanup = () => {
    document.getElementById(ROW_ID)?.remove();
    clearLayoutMarkers();
    document.documentElement.removeAttribute(MENU_HIDDEN_ATTRIBUTE);
    state.sourceSignature = "";
    state.assignees = [];
    state.activeFieldset = null;
  };

  const enhanceAssigneeFilter = async (reason) => {
    if (!state.enabled) {
      cleanup();
      return;
    }

    if (state.running) {
      state.queued = true;
      return;
    }

    state.running = true;
    try {
      if (!isJiraBoardPath()) {
        if (state.boardPath || document.getElementById(ROW_ID)) {
          state.boardPath = "";
          cleanup();
        }
        return;
      }

      if (state.boardPath !== location.pathname) {
        cleanup();
        state.boardPath = location.pathname;
      }

      const fieldset = findAssigneeFilter();
      if (!fieldset) {
        return;
      }

      ensureStyles();
      const visibleAssignees = collectVisibleAssignees(fieldset);
      if (visibleAssignees.length === 0) {
        return;
      }

      const showMoreButton = findShowMoreButton(fieldset);
      const signature = sourceSignatureFor(visibleAssignees, showMoreButton);
      const expectedTotal = visibleAssignees.length + expectedHiddenCount(showMoreButton);
      const canReuseCache = state.sourceSignature === signature &&
        state.assignees.length === expectedTotal;

      if (canReuseCache) {
        if (!document.getElementById(ROW_ID) || state.activeFieldset !== fieldset) {
          renderRow(fieldset, state.assignees, signature);
        }
        syncVisibleSelections(fieldset);
        return;
      }

      let hiddenAssignees = [];
      if (showMoreButton) {
        const discovered = await readHiddenAssignees(fieldset, showMoreButton);
        if (discovered === null) {
          return;
        }
        hiddenAssignees = discovered;
      }

      if (!state.enabled) {
        cleanup();
        return;
      }

      const assignees = mergeAssignees(visibleAssignees, hiddenAssignees);
      if (assignees.length < expectedTotal) {
        log("assignee discovery incomplete", assignees.length, expectedTotal);
        return;
      }

      state.sourceSignature = signature;
      state.assignees = assignees;
      renderRow(fieldset, assignees, signature);
      log("assignee row rendered", reason, assignees.length);
    } catch (error) {
      log("assignee row enhancement failed", reason, error);
    } finally {
      state.running = false;
      if (state.queued) {
        state.queued = false;
        scheduleEnhancement("queued");
      }
    }
  };

  const scheduleEnhancement = (reason) => {
    if (!state.enabled) {
      return;
    }

    if (state.timer) {
      window.clearTimeout(state.timer);
    }

    state.timer = window.setTimeout(() => {
      state.timer = 0;
      void enhanceAssigneeFilter(reason);
    }, MUTATION_DEBOUNCE_MS);
  };

  const clearSelectedStatesSoon = () => {
    window.setTimeout(() => {
      for (const assignee of state.assignees) {
        assignee.selected = false;
      }
      for (const button of document.querySelectorAll(`#${ROW_ID} button[aria-pressed="true"]`)) {
        button.setAttribute("aria-pressed", "false");
      }
      scheduleEnhancement("filters cleared");
    }, 0);
  };

  const onDocumentClick = (event) => {
    const trigger = event.target instanceof Element
      ? event.target.closest("button, [role='button']")
      : null;
    if (!trigger) {
      return;
    }

    const label = normalizeText(trigger.getAttribute("aria-label"));
    if (/^Clear filters$/i.test(normalizeText(trigger.textContent)) || /^Clear filters$/i.test(label)) {
      clearSelectedStatesSoon();
    }
  };

  const onSettingChanged = (changes, areaName) => {
    if (areaName !== "local" || !changes[SETTING_KEY]) {
      return;
    }

    state.enabled = changes[SETTING_KEY].newValue !== false;
    if (state.enabled) {
      scheduleEnhancement("setting enabled");
      return;
    }

    if (state.timer) {
      window.clearTimeout(state.timer);
      state.timer = 0;
    }
    state.queued = false;
    cleanup();
  };

  const start = async () => {
    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("popstate", () => {
      state.sourceSignature = "";
      scheduleEnhancement("history changed");
    });
    window.addEventListener("hashchange", () => scheduleEnhancement("hash changed"));

    const observer = new MutationObserver(() => scheduleEnhancement("dom mutated"));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["aria-checked", "checked"],
      childList: true,
      subtree: true
    });

    chrome.storage.onChanged.addListener(onSettingChanged);

    try {
      const result = await chrome.storage.local.get(SETTING_KEY);
      state.enabled = result[SETTING_KEY] !== false;
    } catch (error) {
      log("could not read assignee row setting; using enabled default", error);
      state.enabled = true;
    }

    if (state.enabled) {
      scheduleEnhancement("startup");
    } else {
      cleanup();
    }
  };

  void start();
})();
