(() => {
  "use strict";

  const BOARD_FILTER_SETTING_KEY = "jiraStandupOrderLocker.clearBoardFiltersOnRefresh";
  const checkbox = document.getElementById("clear-board-filters");
  const status = document.getElementById("status");

  const showSaved = () => {
    status.textContent = "Saved";
    window.setTimeout(() => {
      status.textContent = "";
    }, 1200);
  };

  const load = async () => {
    const result = await chrome.storage.local.get(BOARD_FILTER_SETTING_KEY);
    checkbox.checked = result[BOARD_FILTER_SETTING_KEY] === true;
  };

  checkbox.addEventListener("change", async () => {
    await chrome.storage.local.set({
      [BOARD_FILTER_SETTING_KEY]: checkbox.checked
    });
    showSaved();
  });

  void load();
})();
