# Jira Standup Order Locker

Chrome Manifest V3 extension for Jira Cloud standups.

## Features

- Adds one lock/unlock icon next to Jira Standup's native Previous button.
- Keeps the participant order stable while locked.
- Accepts Jira's native Shuffle button as an intentional new order.
- Persists participated check marks across refreshes during the same standup session.
- Clears the extension cache when Jira's native End standup button is clicked.
- Optional setting to click Jira board Clear filters after opening a board with active filters.

## Install Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository folder.

## Options

Open the extension options to enable or disable board filter clearing. This setting is independent from the standup lock state.

## Files

- `manifest.json` - Chrome extension manifest.
- `content.js` - Jira content script.
- `options.html` / `options.js` - extension options UI.
