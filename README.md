# Prompt paste

Prompt paste is a local-first Chrome extension for storing reusable Prompts and inserting them from the context menu of an editable field. It uses Manifest V3, Vanilla JavaScript, native HTML/CSS, and Chrome Sync. It has no private server, analytics, external runtime dependency, or broad permanent access to websites.

![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![No tracking](https://img.shields.io/badge/tracking-none-16a34a)
![No build step](https://img.shields.io/badge/build%20step-none-2563eb)
[![MIT License](https://img.shields.io/badge/license-MIT-0f172a)](LICENSE)

## Demo

![Prompt paste right-click workflow](docs/assets/demo.gif)

> The animation illustrates the interaction flow. Chrome's native context-menu styling varies by operating system and Chrome version.

The Options page manages categories, Prompts, Chrome Sync usage, pending work, and conflict recovery:

![Prompt paste Options page](docs/assets/options-page.png)

Prompt paste is currently distributed as source for unpacked installation. It is not yet published in the Chrome Web Store.

## Features

- Two-level context menu: `Category → Prompt`.
- Shows saved Prompts as compact summary rows and expands only the Prompt being edited.
- Includes locally packaged toolbar and extension icons in 16, 32, 48, and 128 pixel sizes.
- Inserts at the current caret or replaces the current selection.
- Supports text inputs, textareas, and many `contenteditable` editors.
- Uses native `execCommand("insertText")` first to preserve browser undo history where Chrome supports it.
- Keeps the complete working library in `chrome.storage.local` for fast access.
- Compresses each category independently with LZ-String `compressToUTF16()` before Chrome Sync.
- Normalizes Prompt line endings to LF (`\n`) so Windows and Mac keep the same layout.
- Displays per-category, total Sync, item-count, tombstone, and local-storage usage.
- Persists pending jobs, retries, leases, and conflict state across Service Worker shutdowns.
- Batches multiple category writes into one `chrome.storage.sync.set(payload)` call.
- Garbage-collects synchronized deletion tombstones after 30 days.
- Detects long-offline deletion conflicts instead of silently losing offline edits or resurrecting deleted data.

## Install the unpacked extension

1. Download or copy this complete project directory to the computer.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the directory containing `manifest.json`.
6. Pin Prompt paste if you want quick access to the Options page.
7. Click the toolbar action, or open the extension’s **Details → Extension options**.

The bundled public key produces this expected extension ID:

```text
ggdjhafkodfdkdpjfiiaghedigdbdgpi
```

Confirm that ID in `chrome://extensions` on every device.

## Use it

1. Open the Options page.
2. Create a category.
3. Add one or more Prompts to the category.
4. Open any normal website and focus a text input, textarea, or rich-text editor.
5. Right-click the editable field.
6. Select a category and then a Prompt.

The extension inserts the Prompt as plain text. It never interprets Prompt content as HTML or JavaScript.

## Chrome Sync across Mac and Windows

Chrome isolates `chrome.storage.sync` by Extension ID. Both installations must therefore use the same `manifest.key`.

For synchronization:

1. Use the same `manifest.json` on both devices.
2. Sign in to Chrome with the same Google account.
3. Enable Chrome Sync, including extension/app data.
4. Load the unpacked extension on both devices.
5. Verify that both installations show ID `ggdjhafkodfdkdpjfiiaghedigdbdgpi`.
6. Do not replace or remove `manifest.key` on only one device.

Chrome Sync also works from a local cache while temporarily offline. Propagation timing is controlled by Chrome and is not guaranteed to be instantaneous.

## The fixed `manifest.key`

The `key` in `manifest.json` is a public RSA key. It is safe to distribute. The private key used to derive the bundled public key was not retained or included in this project.

Changing the public key changes the Extension ID and creates a different Chrome Sync namespace. Existing Sync data under the old ID does not automatically migrate.

### Recommended: obtain your own key from Chrome Web Store

Chrome’s documented development workflow is:

1. Zip the extension directory.
2. Add a new item in the Chrome Web Store Developer Dashboard.
3. Upload the zip, but do not publish it.
4. Open the item’s **Package** page.
5. Select **View public key**.
6. Copy the text between `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`.
7. Remove all line breaks.
8. Replace the value of `manifest.key` with that single Base64 line.
9. Use the resulting manifest on every device.

See Chrome’s official [`key` manifest documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key).

### Local OpenSSL method

If OpenSSL is available, create and securely retain a private key:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out prompt-paste.pem
```

Export the DER public key as one Base64 line:

```sh
openssl pkey -in prompt-paste.pem -pubout -outform DER | openssl base64 -A
```

Paste that output into `manifest.key`. Never commit, email, or share `prompt-paste.pem`. The private key is sensitive even though the public `manifest.key` is not.

## Local-first data flow

Ordinary edits follow this order:

```text
Validate and normalize the Prompt
  → commit to chrome.storage.local
  → persist a pending Sync task
  → refresh context menus
  → compress all due categories
  → send one batch chrome.storage.sync.set(payload)
  → clear only revisions confirmed by Chrome Sync
```

If Chrome Sync is offline, disabled, rate-limited, or full, the local edit remains available and the context menu continues to work. The Options page displays the pending or blocked status.

The Service Worker can be terminated when idle. Prompt paste therefore stores its outbox, retry timestamps, synchronization baselines, expiring lease, force-operation phase, and conflicts in `pp:local-meta`. An in-memory queue is only a temporary optimization.

## Data layout

```text
chrome.storage.local
  pp:category:<categoryId>      Uncompressed category object
  pp:local-meta                 Indexes, baselines, durable work, status

chrome.storage.sync
  pp:v1:category:<categoryId>   lz16:v1:<UTF-16 compressed category>
```

Every top-level category is a separate Sync item. A category includes its Prompt titles and bodies. Cloud values are encoded with:

```js
LZString.compressToUTF16(JSON.stringify(category));
```

They are decoded with:

```js
LZString.decompressFromUTF16(compressed);
```

Prompt paste intentionally does not use the raw `LZString.compress()` format.

The vendored LZ-String 1.5.0 source and MIT license are in `vendor/`.

## Line endings

Every Prompt body is normalized before local storage:

```js
String(value).replace(/\r\n?/g, "\n");
```

This changes Windows CRLF and legacy carriage returns to LF. Titles and bodies remain full Unicode; Chinese, Emoji, and other scripts are supported.

## Storage limits and progress bars

Chrome currently exposes these relevant limits:

- Sync item: 8,192 bytes.
- Total Sync storage: 102,400 bytes.
- Sync items: 512.
- Sync writes: 120 operations per minute.
- Sync writes: 1,800 operations per hour.
- Local storage: 10MB.

The category bar estimates the exact key plus JSON-serialized `compressToUTF16()` value. Prompt paste uses a conservative 8,000-byte write threshold while displaying progress against the official 8,192-byte item limit.

An oversized category remains locally usable, but the newer version is not uploaded. Split it into smaller categories to restore synchronization.

The global card distinguishes:

- Actual bytes reported by `chrome.storage.sync.getBytesInUse(null)`.
- Projected bytes after pending changes.
- Sync item count.
- Tombstone and GC counts.
- Local storage use.

See the official [Chrome Storage API reference](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Batch writes and rate limits

Due category records are combined into one call:

```js
await chrome.storage.sync.set({
  "pp:v1:category:id-1": "lz16:v1:...",
  "pp:v1:category:id-2": "lz16:v1:..."
});
```

The implementation never falls back to a loop of one Sync call per category. Expired tombstones are similarly removed with one `chrome.storage.sync.remove(keys)` call.

The extension tracks its own recent write calls and delays new writes before approaching Chrome’s hard minute/hour limits.

## Tombstones and 30-day garbage collection

Deleting a category first uploads a compact `deleted: true` record. This prevents another device with an older copy from immediately recreating the category.

After 30 days, a successfully synchronized tombstone becomes eligible for garbage collection. Eligible keys are removed in one batch so they stop consuming the 512-item quota.

If a device was offline longer than the retention period:

- A stale category with no new local edit accepts the cloud deletion.
- A category with offline edits enters a review conflict.
- **Keep local and restore to cloud** intentionally recreates the category.
- **Accept cloud deletion** removes the offline copy.

## Manual controls

- **Sync to cloud**: makes this device’s complete local library authoritative after a full quota preflight.
- **Force pull from cloud**: replaces local data with the cloud snapshot. Unsynced local changes are discarded after confirmation.
- **Retry pending**: retries eligible pending or transiently blocked work. A category that still exceeds 8KB remains blocked.
- **Clean expired tombstones**: checks all tombstones and removes every eligible cloud key in one batch.

Force operations store their current phase locally and can resume after Service Worker termination.

## Permissions

- `activeTab`: grants temporary page access after the user chooses a context-menu item.
- `contextMenus`: creates the two-level Prompt menu.
- `storage`: stores local data, Sync data, durable task state, and one-time insertion requests.
- `scripting`: dynamically injects `content.js` into the selected frame.
- `alarms`: performs 30-minute reconciliation and durable retries.

There is no `<all_urls>` declaration and no permanent host permission.

## Repeat-safe dynamic insertion

`content.js` is injected again for every insertion. Its complete code is enclosed in an async IIFE, so reinjection does not redeclare top-level lexical variables. It creates no global insertion function and no persistent listener.

The Prompt is handed off through a short-lived `chrome.storage.session` request. The injected IIFE claims that request through extension messaging, restores focus and selection, inserts the text, and exits.

Insertion order:

1. Restore and verify focus.
2. Restore the caret or selection.
3. Try `document.execCommand("insertText")`.
4. Fall back to `setRangeText()` for text controls.
5. Fall back to Selection/Range for `contenteditable`.

## Browser limitations

Chrome does not permit script injection into some protected surfaces, including:

- `chrome://` pages.
- The Chrome Web Store.
- Some built-in viewers.
- Cross-origin iframe situations where temporary host access is insufficient.
- Closed Shadow DOM editors.

Some highly customized editors may also reject synthetic fallback events. Native `execCommand("insertText")` is attempted first because it gives Chrome the best opportunity to preserve editor events and Ctrl+Z/Command+Z history.

Chrome’s native context menu cannot render custom HTML or progress bars. Storage bars therefore appear in the Options page only.

## Privacy and security

- No Prompt is sent to a private server.
- No analytics or tracking is included.
- No Prompt is inserted as HTML.
- Chrome local and Sync storage are not a password vault.
- Do not store passwords, private API keys, access tokens, recovery codes, or other secrets as Prompts.

## Development checks

From the project directory:

```sh
node --check background.js
node --check content.js
node --check options.js
node --check storage.js
python3 -m json.tool manifest.json
node tests/verify.mjs
node tests/background-mock.mjs
```

On macOS with Google Chrome installed in `/Applications`, the real-browser CDP smoke test is also available:

```sh
node tests/chrome-cdp-smoke.mjs
```

It uses Chrome’s current `Extensions.loadUnpacked` testing API, creates an isolated temporary profile, verifies the fixed ID and Options page, and removes the profile when complete. Set `CHROME_PATH` if Chrome is installed somewhere else.

Finally, load the directory in `chrome://extensions`, inspect the Service Worker console, and test repeated insertion into the same page.

## Contributing and security

Bug reports and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Please report security-sensitive findings using the process in [SECURITY.md](SECURITY.md), not in a public issue.

The extension's data handling and permission purposes are documented in [PRIVACY.md](PRIVACY.md).

## License

Prompt paste is released under the [MIT License](LICENSE). The bundled LZ-String dependency retains its own MIT notice; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
