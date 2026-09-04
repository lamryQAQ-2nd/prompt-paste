# Contributing to Prompt paste

Thanks for helping improve Prompt paste. Small, focused changes with a clear reason and verification are easiest to review.

## Before opening an issue

1. Search existing issues for the same behavior or request.
2. Confirm the problem on a current stable version of Google Chrome.
3. Note whether the target is an `input`, `textarea`, or `contenteditable` editor.
4. Do not include saved Prompt contents, account information, tokens, or other secrets.

## Development setup

There is no package installation or build step. Clone the repository and load its root directory from `chrome://extensions` using **Developer mode → Load unpacked**.

Run the portable checks before submitting a pull request:

```sh
node --check background.js
node --check content.js
node --check options.js
node --check storage.js
python3 -m json.tool manifest.json
node tests/verify.mjs
node tests/background-mock.mjs
```

On macOS with Google Chrome installed in `/Applications`, also run:

```sh
node tests/chrome-cdp-smoke.mjs
```

## Pull requests

- Keep changes scoped to one problem or feature.
- Explain the user-visible behavior and why the change is needed.
- Add or update tests when behavior changes.
- Preserve the local-first model and avoid adding analytics or external runtime dependencies.
- Keep permissions minimal. Explain any permission change in the pull request and update `README.md` and `PRIVACY.md`.
- Do not commit private extension keys, Chrome profiles, generated `.crx` files, or user data.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
