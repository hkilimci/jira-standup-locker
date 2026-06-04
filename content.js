(() => {
  "use strict";

  const DEBUG = false;
  const STORAGE_KEY = "jiraStandupOrderLocker.cache";
  const BOARD_FILTER_SETTING_KEY = "jiraStandupOrderLocker.clearBoardFiltersOnRefresh";
  const LOCK_BUTTON_ID = "jira-standup-order-locker-toggle";
  const DEFAULT_LOCKED = true;
  const MUTATION_DEBOUNCE_MS = 150;
  const INACTIVE_GRACE_MS = 4000;
  const MANUAL_SHUFFLE_WINDOW_MS = 3000;
  const END_STANDUP_SUPPRESS_MS = 5000;
  const CLEAR_FILTER_RETRY_MS = 500;
  const CLEAR_FILTER_WINDOW_MS = 30000;
  const CLEAR_FILTER_MAX_CLICKS = 6;
  const POST_SHUFFLE_CHECK_MS = [350, 900, 1800, 2800];

  const SELECTORS = {
    standupRoot: [
      '[data-testid="standups.ui.wrapper"]',
      '[aria-label="Standup"][role="region"]'
    ],
    participantList: [
      '[data-testid="rituals.standups.participant.list"]'
    ],
    participantItem: '[data-testid="rituals.standups.participant.item"]',
    previousButton: [
      'button[aria-label="Previous standup member"]',
      'button[aria-label*="Previous" i]'
    ],
    shuffleButton: [
      'button[aria-label*="Shuffle" i]'
    ]
  };

  const state = {
    cache: null,
    active: false,
    everObservedActive: false,
    currentSessionKey: null,
    inactiveTimer: 0,
    reconcileTimer: 0,
    restoring: false,
    applyingMarkers: false,
    manualShuffleUntil: 0,
    suppressCacheUntil: 0,
    boardFiltersClearedOnLoad: false,
    boardFilterClearUntil: 0,
    boardFilterClearClicks: 0,
    boardFilterClearTimer: 0,
    storageReady: false,
    running: false,
    queued: false
  };

  const log = (...args) => {
    if (DEBUG) {
      console.debug("[Jira Standup Locker]", ...args);
    }
  };

  const storage = {
    async get() {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] ?? null;
    },
    async set(cache) {
      state.cache = cache;
      await chrome.storage.local.set({ [STORAGE_KEY]: cache });
    }
  };

  const clearStoredCache = async () => {
    state.cache = null;
    state.active = false;
    state.currentSessionKey = null;
    await chrome.storage.local.remove(STORAGE_KEY);
    updateLockButton();
    log("cache cleared");
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

  const todayLocal = () => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const normalizeName = (value) => {
    return String(value ?? "")
      .replace(/\s+\(Participated\)$/i, "")
      .replace(/\s+\(Skipped from standup\)$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const arraysEqual = (left, right) => {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  };

  const orderNamesByParticipantOrder = (participantOrder, names) => {
    const nameSet = new Set(names);
    const ordered = participantOrder.filter((name) => nameSet.has(name));
    const extras = [...nameSet]
      .filter((name) => !ordered.includes(name))
      .sort((a, b) => a.localeCompare(b));
    return [...ordered, ...extras];
  };

  const hashStrings = (values) => {
    const input = JSON.stringify(values);
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };

  const participantHashFor = (names) => {
    return hashStrings([...names].sort((a, b) => a.localeCompare(b)));
  };

  const textMatches = (element, pattern) => {
    return pattern.test((element.textContent || "").replace(/\s+/g, " ").trim());
  };

  const findStandupRoot = () => {
    return queryFirst(document, SELECTORS.standupRoot);
  };

  const findPreviousButton = (root) => {
    const bySelector = queryFirst(root, SELECTORS.previousButton);
    if (bySelector) {
      return bySelector;
    }

    return Array.from(root.querySelectorAll("button")).find((button) => {
      return textMatches(button, /^Previous$/i);
    }) ?? null;
  };

  const findShuffleButton = (root) => {
    const bySelector = queryFirst(root, SELECTORS.shuffleButton);
    if (bySelector) {
      return bySelector;
    }

    return Array.from(root.querySelectorAll("button")).find((button) => {
      return textMatches(button, /shuffle standup members|shuffle/i);
    }) ?? null;
  };

  const isEndStandupTrigger = (element) => {
    return textMatches(element, /^End standup$/i) ||
      /^End standup$/i.test(element.getAttribute("aria-label") || "");
  };

  const isJiraBoardPath = () => {
    return /\/jira\/software\/c\/projects\/[^/]+\/boards\/\d+/.test(location.pathname);
  };

  const hasBoardFilterParams = () => {
    return /[?&](text|quickFilter|assignee|label|labels|epics|issueType|issueTypes|issueParent|customFilter|statuses|sprints)=/i
      .test(location.search);
  };

  const findClearFiltersButton = () => {
    const clearButtonContainer = document.querySelector(
      '[data-testid="filters.ui.filters.clear-button.ak-button"], [data-test-id="filters.ui.filters.clear-button.ak-button"]'
    );
    const clearButton = clearButtonContainer?.querySelector("button");
    if (clearButton) {
      return clearButton;
    }

    return Array.from(document.querySelectorAll("button, [role='button']")).find((element) => {
      return textMatches(element, /^Clear filters$/i) ||
        /^Clear filters$/i.test(element.getAttribute("aria-label") || "");
    }) ?? null;
  };

  const isActionableElement = (element) => {
    if (!element || !element.isConnected) {
      return false;
    }

    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none";
  };

  const clickElementLikeUser = (element) => {
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + (rect.width / 2),
      clientY: rect.top + (rect.height / 2),
      view: window
    };

    element.dispatchEvent(new MouseEvent("mouseover", eventInit));
    element.dispatchEvent(new MouseEvent("mousemove", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.dispatchEvent(new MouseEvent("click", eventInit));
  };

  const scheduleBoardFilterClearAttempt = (delay = CLEAR_FILTER_RETRY_MS) => {
    if (state.boardFilterClearTimer) {
      window.clearTimeout(state.boardFilterClearTimer);
    }

    state.boardFilterClearTimer = window.setTimeout(() => {
      state.boardFilterClearTimer = 0;
      attemptBoardFilterClear();
    }, delay);
  };

  const attemptBoardFilterClear = () => {
    if (Date.now() > state.boardFilterClearUntil) {
      return;
    }

    const button = findClearFiltersButton();
    if (isActionableElement(button)) {
      state.boardFilterClearClicks += 1;
      clickElementLikeUser(button);
      log("board filters clear click", state.boardFilterClearClicks);
      if (state.boardFilterClearClicks >= CLEAR_FILTER_MAX_CLICKS) {
        state.boardFilterClearUntil = 0;
        return;
      }
      scheduleBoardFilterClearAttempt(900);
      return;
    }

    // Button gone after at least one click: load-time filters are cleared.
    // Close the window so filters the user applies afterwards are untouched.
    if (state.boardFilterClearClicks > 0) {
      state.boardFilterClearUntil = 0;
      return;
    }

    scheduleBoardFilterClearAttempt();
  };

  const isBoardFilterClearEnabled = async () => {
    const result = await chrome.storage.local.get(BOARD_FILTER_SETTING_KEY);
    return result[BOARD_FILTER_SETTING_KEY] === true;
  };

  const clearBoardFiltersOnInitialLoad = async () => {
    if (state.boardFiltersClearedOnLoad || !isJiraBoardPath()) {
      return;
    }

    if (!await isBoardFilterClearEnabled()) {
      state.boardFiltersClearedOnLoad = true;
      return;
    }

    state.boardFiltersClearedOnLoad = true;
    if (!hasBoardFilterParams() && !findClearFiltersButton()) {
      return;
    }

    state.boardFilterClearUntil = Date.now() + CLEAR_FILTER_WINDOW_MS;
    state.boardFilterClearClicks = 0;
    scheduleBoardFilterClearAttempt(1000);
  };

  const findParticipantList = (root) => {
    const bySelector = queryFirst(root, SELECTORS.participantList);
    if (bySelector) {
      return bySelector;
    }

    const items = Array.from(root.querySelectorAll(SELECTORS.participantItem));
    if (items.length === 0) {
      return null;
    }

    return items.reduce((candidate, item) => {
      let node = item.parentElement;
      while (node && node !== root) {
        if (node.querySelectorAll(SELECTORS.participantItem).length === items.length) {
          candidate = node;
        }
        node = node.parentElement;
      }
      return candidate;
    }, null);
  };

  const findOrderContainer = (list) => {
    const directContainer = Array.from(list.children).find((child) => {
      return child.querySelectorAll(SELECTORS.participantItem).length >= 2;
    });

    return directContainer ?? list;
  };

  const getItemName = (item) => {
    const labeledButton = Array.from(item.querySelectorAll("button[aria-label]")).find((button) => {
      const label = normalizeName(button.getAttribute("aria-label"));
      return label && !/remove from standup/i.test(label);
    });

    if (labeledButton) {
      return normalizeName(labeledButton.getAttribute("aria-label"));
    }

    const clone = item.cloneNode(true);
    for (const button of clone.querySelectorAll("button")) {
      if (/remove from standup/i.test(button.textContent || "")) {
        button.remove();
      }
    }
    return normalizeName(clone.textContent);
  };

  const isNativeParticipatedItem = (item) => {
    const hasSyntheticBadge = Boolean(item.querySelector("[data-jira-standup-locker-participated]"));

    if (Array.from(item.querySelectorAll("button[aria-label]")).some((button) => {
      return /\(Participated\)/i.test(button.getAttribute("aria-label") || "") && !hasSyntheticBadge;
    })) {
      return true;
    }

    return /\(approved\)/i.test(item.textContent || "");
  };

  const isParticipatedItem = (item) => {
    if (isNativeParticipatedItem(item)) {
      return true;
    }

    if (item.querySelector("[data-jira-standup-locker-participated]")) {
      return true;
    }

    return false;
  };

  const getParticipantRows = (root) => {
    const list = findParticipantList(root);
    if (!list) {
      return null;
    }

    const container = findOrderContainer(list);
    const rows = [];

    for (const unit of Array.from(container.children)) {
      const item = unit.matches(SELECTORS.participantItem)
        ? unit
        : unit.querySelector(SELECTORS.participantItem);

      if (!item) {
        continue;
      }

      const name = getItemName(item);
      if (!name) {
        continue;
      }

      rows.push({
        unit,
        item,
        name,
        participated: isParticipatedItem(item),
        nativeParticipated: isNativeParticipatedItem(item)
      });
    }

    return rows.length > 0 ? { container, rows } : null;
  };

  const createSessionKey = (snapshot) => {
    const path = `${location.origin}${location.pathname}`;
    return `${todayLocal()}|${path}|${snapshot.participantHash}|${Date.now()}`;
  };

  const getSnapshot = (root) => {
    const listInfo = getParticipantRows(root);
    if (!listInfo) {
      return null;
    }

    const participantOrder = listInfo.rows.map((row) => row.name);
    const participatedNames = listInfo.rows
      .filter((row) => row.participated)
      .map((row) => row.name);
    const nativeParticipatedNames = listInfo.rows
      .filter((row) => row.nativeParticipated)
      .map((row) => row.name);
    return {
      ...listInfo,
      date: todayLocal(),
      participantOrder,
      participatedNames,
      nativeParticipatedNames,
      participantHash: participantHashFor(participantOrder)
    };
  };

  const makeCache = (
    snapshot,
    locked,
    participatedNames = snapshot.participatedNames
  ) => {
    return {
      date: snapshot.date,
      locked,
      participantHash: snapshot.participantHash,
      participantOrder: snapshot.participantOrder,
      participatedNames: orderNamesByParticipantOrder(
        snapshot.participantOrder,
        participatedNames
      ),
      standupSessionKey: state.currentSessionKey ?? createSessionKey(snapshot),
      updatedAt: Date.now()
    };
  };

  const getStoredLockedState = () => {
    return typeof state.cache?.locked === "boolean" ? state.cache.locked : DEFAULT_LOCKED;
  };

  const refreshCache = async (
    snapshot,
    reason,
    locked = getStoredLockedState(),
    participatedNames = snapshot.participatedNames
  ) => {
    if (!state.currentSessionKey) {
      state.currentSessionKey = createSessionKey(snapshot);
    }

    const cache = makeCache(snapshot, locked, participatedNames);
    await storage.set(cache);
    log("cache refreshed", reason, cache);
  };

  const setLocked = async (locked, snapshot) => {
    if (snapshot) {
      await refreshCache(snapshot, locked ? "locked by user" : "unlocked by user", locked);
    } else {
      const fallback = state.cache ?? {
        date: todayLocal(),
        locked: DEFAULT_LOCKED,
        participantHash: "",
        participantOrder: [],
        participatedNames: [],
        standupSessionKey: "",
        updatedAt: Date.now()
      };
      await storage.set({ ...fallback, locked, updatedAt: Date.now() });
    }
    updateLockButton();
  };

  const updateLockButton = () => {
    const button = document.getElementById(LOCK_BUTTON_ID);
    if (!button) {
      return;
    }

    const locked = getStoredLockedState();
    button.textContent = locked ? "🔒" : "🔓";
    button.setAttribute(
      "aria-label",
      locked ? "Unlock standup participant order" : "Lock standup participant order"
    );
    button.setAttribute(
      "title",
      locked ? "Unlock standup participant order" : "Lock standup participant order"
    );
    button.setAttribute("aria-pressed", String(locked));
  };

  const ensureLockButton = (root, snapshot) => {
    const previousButton = findPreviousButton(root);
    if (!previousButton || document.getElementById(LOCK_BUTTON_ID)) {
      updateLockButton();
      return;
    }

    const button = document.createElement("button");
    button.id = LOCK_BUTTON_ID;
    button.type = "button";
    button.style.alignItems = "center";
    button.style.background = "transparent";
    button.style.border = "1px solid transparent";
    button.style.borderRadius = "3px";
    button.style.boxSizing = "border-box";
    button.style.color = "currentColor";
    button.style.cursor = "pointer";
    button.style.display = "inline-flex";
    button.style.fontSize = "14px";
    button.style.height = "32px";
    button.style.justifyContent = "center";
    button.style.lineHeight = "1";
    button.style.margin = "0 2px 0 0";
    button.style.minWidth = "32px";
    button.style.padding = "0";
    button.style.verticalAlign = "middle";

    button.addEventListener("mouseenter", () => {
      button.style.background = "rgba(9, 30, 66, 0.08)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = "transparent";
    });
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const latestRoot = findStandupRoot();
      const latestSnapshot = latestRoot ? getSnapshot(latestRoot) : snapshot;
      await setLocked(!state.cache?.locked, latestSnapshot);
      scheduleReconcile("lock toggled");
    });

    previousButton.insertAdjacentElement("beforebegin", button);
    updateLockButton();
  };

  const createParticipatedBadge = () => {
    const badge = document.createElement("span");
    badge.dataset.jiraStandupLockerParticipated = "true";
    badge.setAttribute("aria-hidden", "true");
    badge.style.alignItems = "center";
    badge.style.background = "var(--ds-icon-success, #6A9A23)";
    badge.style.border = "2px solid var(--ds-surface, #FFFFFF)";
    badge.style.borderRadius = "50%";
    badge.style.bottom = "-1px";
    badge.style.boxSizing = "border-box";
    badge.style.color = "var(--ds-surface-overlay, #FFFFFF)";
    badge.style.display = "inline-flex";
    badge.style.height = "12px";
    badge.style.justifyContent = "center";
    badge.style.position = "absolute";
    badge.style.right = "-1px";
    badge.style.width = "12px";
    badge.innerHTML = [
      '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true" focusable="false">',
      '<path fill="currentColor" d="M2.47 3.53a.67.67 0 0 0-.94.94l1.33 1.33c.26.26.68.26.94 0l2.67-2.66a.67.67 0 1 0-.94-.95L3.33 4.39z"></path>',
      "</svg>"
    ].join("");
    return badge;
  };

  const removeSyntheticParticipatedMarks = (root) => {
    for (const badge of root.querySelectorAll("[data-jira-standup-locker-participated]")) {
      badge.remove();
    }

    for (const button of root.querySelectorAll("[data-jira-standup-locker-original-label]")) {
      button.setAttribute("aria-label", button.dataset.jiraStandupLockerOriginalLabel);
      delete button.dataset.jiraStandupLockerOriginalLabel;
    }
  };

  const applyParticipatedMarks = (snapshot) => {
    const participatedNames = new Set(state.cache?.participatedNames ?? []);
    if (participatedNames.size === 0) {
      return;
    }

    const rowsToMark = snapshot.rows.filter((row) => {
      return participatedNames.has(row.name) && !row.participated;
    });
    if (rowsToMark.length === 0) {
      return;
    }

    state.applyingMarkers = true;
    try {
      for (const row of rowsToMark) {
        const participantButton = Array.from(row.item.querySelectorAll("button[aria-label]")).find((button) => {
          const label = normalizeName(button.getAttribute("aria-label"));
          return label === row.name;
        });
        if (participantButton && !/\(Participated\)/i.test(participantButton.getAttribute("aria-label") || "")) {
          participantButton.dataset.jiraStandupLockerOriginalLabel = participantButton.getAttribute("aria-label") || row.name;
          participantButton.setAttribute("aria-label", `${row.name} (Participated)`);
        }

        const avatarImage = row.item.querySelector('img[data-vc="avatar-image"], img[aria-hidden="true"]');
        const avatarWrapper = avatarImage?.closest("span");
        const avatarContainer = avatarWrapper?.parentElement;
        if (!avatarContainer || avatarContainer.querySelector("[data-jira-standup-locker-participated]")) {
          continue;
        }

        if (getComputedStyle(avatarContainer).position === "static") {
          avatarContainer.style.position = "relative";
        }
        avatarContainer.appendChild(createParticipatedBadge());
      }
    } finally {
      window.setTimeout(() => {
        state.applyingMarkers = false;
        scheduleReconcile("post participated marker apply");
      }, MUTATION_DEBOUNCE_MS);
    }
  };

  const mergeParticipatedNames = async (snapshot) => {
    if (!state.cache) {
      return false;
    }

    const merged = orderNamesByParticipantOrder(snapshot.participantOrder, [
      ...(state.cache.participatedNames ?? []),
      ...snapshot.participatedNames
    ]);

    const current = orderNamesByParticipantOrder(
      snapshot.participantOrder,
      state.cache.participatedNames ?? []
    );

    if (arraysEqual(current, merged)) {
      return false;
    }

    await storage.set({
      ...state.cache,
      participatedNames: merged,
      updatedAt: Date.now()
    });
    log("participated marks cached", merged);
    return true;
  };

  const restoreOrder = (snapshot, cachedOrder) => {
    const rowsByName = new Map();

    for (const row of snapshot.rows) {
      const queue = rowsByName.get(row.name) ?? [];
      queue.push(row);
      rowsByName.set(row.name, queue);
    }

    const desiredUnits = [];
    for (const name of cachedOrder) {
      const queue = rowsByName.get(name);
      if (!queue?.length) {
        log("cannot restore; cached participant is not visible", name);
        return false;
      }
      desiredUnits.push(queue.shift().unit);
    }

    const currentUnits = snapshot.rows.map((row) => row.unit);
    if (arraysEqual(currentUnits, desiredUnits)) {
      return false;
    }

    state.restoring = true;
    for (const unit of desiredUnits) {
      snapshot.container.appendChild(unit);
    }

    window.setTimeout(() => {
      state.restoring = false;
      scheduleReconcile("post restore");
    }, MUTATION_DEBOUNCE_MS);

    log("restored participant order", cachedOrder);
    return true;
  };

  const markInactiveSoon = () => {
    if (state.inactiveTimer) {
      return;
    }

    state.inactiveTimer = window.setTimeout(() => {
      state.inactiveTimer = 0;
      state.active = false;
      state.currentSessionKey = null;
      log("standup marked inactive");
    }, INACTIVE_GRACE_MS);
  };

  const markActive = async (snapshot, root) => {
    if (state.inactiveTimer) {
      window.clearTimeout(state.inactiveTimer);
      state.inactiveTimer = 0;
    }

    if (state.active) {
      return false;
    }

    state.active = true;
    const wasPreviouslyActive = state.everObservedActive;
    state.everObservedActive = true;

    if (wasPreviouslyActive) {
      removeSyntheticParticipatedMarks(root);
      const cleanSnapshot = getSnapshot(root) ?? snapshot;
      state.currentSessionKey = createSessionKey(cleanSnapshot);
      await refreshCache(
        cleanSnapshot,
        "new active standup session",
        getStoredLockedState(),
        cleanSnapshot.nativeParticipatedNames
      );
      return true;
    }

    state.currentSessionKey = state.cache?.standupSessionKey || createSessionKey(snapshot);
    return false;
  };

  const isManualShuffleWindowOpen = () => Date.now() < state.manualShuffleUntil;

  const reconcile = async (reason) => {
    if (state.running) {
      state.queued = true;
      return;
    }

    state.running = true;
    try {
      if (!state.storageReady) {
        state.cache = await storage.get();
        state.storageReady = true;
      }

      const root = findStandupRoot();
      const snapshot = root ? getSnapshot(root) : null;
      if (!root || !snapshot) {
        markInactiveSoon();
        return;
      }

      ensureLockButton(root, snapshot);

      // After End standup the standup DOM can linger briefly; skip cache
      // writes so the cleared cache is not immediately recreated.
      if (Date.now() < state.suppressCacheUntil) {
        return;
      }

      const refreshedForSession = await markActive(snapshot, root);
      if (refreshedForSession) {
        return;
      }

      if (!state.cache) {
        await refreshCache(snapshot, "initial cache");
        updateLockButton();
        return;
      }

      const locked = Boolean(state.cache.locked);
      if (state.cache.date !== snapshot.date) {
        removeSyntheticParticipatedMarks(root);
        const cleanSnapshot = getSnapshot(root) ?? snapshot;
        await refreshCache(cleanSnapshot, "new local day", locked, cleanSnapshot.nativeParticipatedNames);
        updateLockButton();
        return;
      }

      if (state.cache.participantHash !== snapshot.participantHash) {
        await refreshCache(snapshot, "participant list changed", locked);
        updateLockButton();
        return;
      }

      await mergeParticipatedNames(snapshot);
      applyParticipatedMarks(snapshot);

      if (isManualShuffleWindowOpen()) {
        if (!arraysEqual(state.cache.participantOrder, snapshot.participantOrder)) {
          await refreshCache(snapshot, "native shuffle accepted", locked);
          updateLockButton();
        }
        return;
      }

      if (!locked || state.restoring) {
        return;
      }

      if (!arraysEqual(state.cache.participantOrder, snapshot.participantOrder)) {
        restoreOrder(snapshot, state.cache.participantOrder);
      }
    } catch (error) {
      log("reconcile failed", reason, error);
    } finally {
      state.running = false;
      if (state.queued) {
        state.queued = false;
        scheduleReconcile("queued");
      }
    }
  };

  const scheduleReconcile = (reason) => {
    if (state.reconcileTimer) {
      window.clearTimeout(state.reconcileTimer);
    }

    state.reconcileTimer = window.setTimeout(() => {
      state.reconcileTimer = 0;
      void reconcile(reason);
    }, MUTATION_DEBOUNCE_MS);
  };

  const onDocumentClick = (event) => {
    const trigger = event.target instanceof Element
      ? event.target.closest("button, [role='button'], [role='menuitem']")
      : null;
    if (!trigger || trigger.id === LOCK_BUTTON_ID) {
      return;
    }

    // End standup may live in a confirmation modal rendered outside the
    // standup root, so match it anywhere in the document.
    if (isEndStandupTrigger(trigger)) {
      state.suppressCacheUntil = Date.now() + END_STANDUP_SUPPRESS_MS;
      void clearStoredCache();
      return;
    }

    const root = findStandupRoot();
    if (!root || !root.contains(trigger)) {
      return;
    }

    if (trigger === findShuffleButton(root)) {
      state.manualShuffleUntil = Date.now() + MANUAL_SHUFFLE_WINDOW_MS;
      log("native shuffle detected");
      for (const delay of POST_SHUFFLE_CHECK_MS) {
        window.setTimeout(() => scheduleReconcile("post native shuffle"), delay);
      }
    }
  };

  const watchUrlChanges = () => {
    const notify = () => scheduleReconcile("url changed");
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }
    window.addEventListener("popstate", notify);
    window.addEventListener("hashchange", notify);
  };

  const start = () => {
    document.addEventListener("click", onDocumentClick, true);
    watchUrlChanges();
    void clearBoardFiltersOnInitialLoad();

    const observer = new MutationObserver(() => {
      if (!state.restoring && !state.applyingMarkers) {
        scheduleReconcile("dom mutated");
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    scheduleReconcile("startup");
  };

  start();
})();
