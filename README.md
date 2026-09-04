# Prompt paste

[Chinese](README.zh-CN.md)

A small, local-first Chrome extension for pasting reusable text from the right-click menu.

Save Prompts into categories, right-click any editable field, and choose `Category → Prompt`. Prompt paste inserts the saved text at the caret or replaces the current selection.

![Prompt paste right-click workflow](docs/assets/demo.gif)

> The animation illustrates the interaction flow. Chrome's native context-menu appearance varies by operating system and Chrome version.

## Features

- Insert reusable text from the right-click menu.
- Organize Prompts into categories.
- Works with text inputs, textareas, and many rich-text editors.
- Inserts at the caret or replaces selected text.
- Stores the working library locally and syncs it through Chrome Sync.
- No analytics, tracking, private server, or permanent access to every website.

## Install

1. Download this repository and unzip it, or clone it with Git.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the project directory containing `manifest.json`.
6. Click the Prompt paste toolbar icon to open the Options page.

The bundled public key gives the unpacked extension this fixed ID:

```text
ggdjhafkodfdkdpjfiiaghedigdbdgpi
```

Keep the same `manifest.json` on every device if you want them to share the same Chrome Sync data.

## Use

1. Open the Prompt paste Options page.
2. Create a category.
3. Add one or more Prompts.
4. Focus an editable field on a normal webpage.
5. Right-click and select a category, then a Prompt.

The Prompt is inserted as plain text.

![Prompt paste Options page](docs/assets/options-page.png)

## Sync and privacy

Prompt paste keeps the complete working library in `chrome.storage.local`. Compressed category records are synchronized with `chrome.storage.sync` when Chrome Sync is available.

The extension has no analytics, advertising, tracking, or developer-operated server. Chrome storage is not a password vault, so do not save passwords, API keys, access tokens, or recovery codes as Prompts.

## Development

There is no build step or package installation. The main checks are:

```sh
node tests/verify.mjs
node tests/background-mock.mjs
```

On macOS with Google Chrome installed in `/Applications`:

```sh
node tests/chrome-cdp-smoke.mjs
```

## License

MIT. See [LICENSE](LICENSE). The vendored LZ-String license is preserved in `vendor/LZ-STRING-LICENSE.txt`.
