# Privacy policy

Last updated: September 5, 2026

Prompt paste is a local-first Chrome extension. It does not operate a private server and does not include analytics, advertising, telemetry, or tracking code.

## Data handled by the extension

The extension handles only the categories and reusable text ("Prompts") that a user creates, plus synchronization metadata needed to keep those records consistent.

- The complete working library is stored in `chrome.storage.local` on the user's device.
- Compressed category records are stored in `chrome.storage.sync` when Chrome Sync is available.
- Short-lived insertion requests are stored in `chrome.storage.session` and removed after they are claimed or expire.
- Prompt text is inserted only after the user selects a context-menu item in an editable field.

Chrome Sync is provided and controlled by Google Chrome. Its availability, transmission, retention, and account security are subject to the user's Chrome and Google account settings and Google's applicable policies.

## Data collection and sharing

Prompt paste does not collect, sell, rent, transmit to the developer, or share user Prompts or browsing activity with third parties. The extension makes no application-level network requests and has no external runtime dependencies.

## Permissions

- `activeTab`: temporary access to the current page after the user chooses a Prompt.
- `contextMenus`: displays categories and Prompts in Chrome's editable-field context menu.
- `storage`: saves local data, Chrome Sync data, durable synchronization state, and short-lived insertion requests.
- `scripting`: injects the local insertion script into the selected frame after a user action.
- `alarms`: schedules reconciliation, cleanup, and retries for pending Chrome Sync work.

The extension does not request `<all_urls>` or permanent host access.

## Sensitive information

Chrome local and Sync storage are not a password vault. Users should not save passwords, API keys, access tokens, recovery codes, financial information, health information, or other highly sensitive data as Prompts.

## Data removal

Users can delete individual categories from the Options page. A synchronized deletion marker may be retained for up to 30 days to prevent an offline device from recreating deleted data. Expired deletion markers are eligible for cleanup.

Removing the extension deletes its local extension storage from that Chrome profile. Chrome Sync data is managed by Chrome and may remain available to another installation using the same extension ID and signed-in Chrome account until it is deleted or cleared through Chrome.

## Changes and questions

Material privacy changes will be documented in this file and reflected by the "Last updated" date. Questions may be opened as a GitHub issue in this repository, but users should never include private Prompt contents or other secrets in an issue.
