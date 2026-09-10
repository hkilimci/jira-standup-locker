(() => {
  "use strict";

  const BOARD_FILTER_SETTING_KEY = "jiraStandupOrderLocker.clearBoardFiltersOnRefresh";
  const EXPANDED_ASSIGNEE_FILTER_SETTING_KEY = "jiraStandupOrderLocker.expandBoardAssigneeFilters";
  const clearBoardFiltersCheckbox = document.getElementById("clear-board-filters");
  const expandBoardAssigneesCheckbox = document.getElementById("expand-board-assignees");
  const status = document.getElementById("status");

  const showSaved = () => {
    status.textContent = "Saved";
    window.setTimeout(() => {
      status.textContent = "";
    }, 1200);
  };

  const load = async () => {
    const result = await chrome.storage.local.get([
      BOARD_FILTER_SETTING_KEY,
      EXPANDED_ASSIGNEE_FILTER_SETTING_KEY
    ]);
    clearBoardFiltersCheckbox.checked = result[BOARD_FILTER_SETTING_KEY] === true;
    expandBoardAssigneesCheckbox.checked = result[EXPANDED_ASSIGNEE_FILTER_SETTING_KEY] !== false;
  };

  clearBoardFiltersCheckbox.addEventListener("change", async () => {
    await chrome.storage.local.set({
      [BOARD_FILTER_SETTING_KEY]: clearBoardFiltersCheckbox.checked
    });
    showSaved();
  });

  expandBoardAssigneesCheckbox.addEventListener("change", async () => {
    await chrome.storage.local.set({
      [EXPANDED_ASSIGNEE_FILTER_SETTING_KEY]: expandBoardAssigneesCheckbox.checked
    });
    showSaved();
  });

  void load();
})();
