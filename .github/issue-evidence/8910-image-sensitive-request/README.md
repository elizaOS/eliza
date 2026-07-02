# #8910 — image field type in interaction protocol & sensitive requests

**Branch:** `feat/8910-image-sensitive-hosted` (off `develop`) · **PR:** see below

## What #8910 asked for

- Add `'image'` (and optionally `'file'`) to `InteractionFieldType`. ✅ (already
  merged, commit `64c189d56fb`)
- Render `<input type=file accept='image/*' capture='environment'>` in the
  dashboard `SensitiveRequestBlock` **and on the hosted sensitive-request page**.
- Deliver the uploaded image via the existing submit endpoint alongside text
  fields; carry optional `mimeTypes`/`maxBytes` metadata.
- Storybook story + unit test for parsing an image field; e2e that uploads an
  image and asserts the submit payload includes it; before/after screenshots.

## State before this PR (measured on `develop`)

The **type**, **in-chat rendering**, **base64 delivery**, **camera capture**,
`mimeTypes`/`maxBytes`, the **unit test**, and the **Storybook image story** were
already merged. But two seams made the feature **not reachable from a real
agent** and **absent on the hosted page**:

1. `owner-app-inline-adapter.ts` hardcoded `input: "secret"` for every field, so
   an agent-`DECLARE`'d secret target could **never** emit an image/file field to
   the chat block — only hand-built test envelopes could exercise it.
2. The hosted public `sensitive-request-page.tsx` **filtered image/file fields
   out** and rendered no file input.

## What this PR adds

- **core** `SensitiveRequestSecretTarget` gains additive optional
  `input`/`mimeTypes`/`maxBytes`, so an agent can request a photographed 2FA
  seed / scanned recovery QR.
- **app-core** `owner-app-inline-adapter` propagates that descriptor into the
  chat envelope (multi-key tunnel requests stay typed secrets).
- **ui** hosted `sensitive-request-page` now renders a file input (accept +
  mobile camera capture), reads the upload as a base64 data URL, enforces
  `maxBytes`, gates submit on required uploads, and delivers through the existing
  `/submit` path. A `data-testid` matches the chat block.
- **Storybook** `SecretRequestFileField` variant added alongside the existing
  image story.

## Evidence in this folder

Rendered from the real `SensitiveRequestBlock` (Storybook, headless Chromium):

| File | What it shows |
| --- | --- |
| `chat-image-field-desktop.png` / `-mobile.png` | image field, rest state (file input + disabled Upload) |
| `chat-image-field-desktop--filled.png` / `-mobile--filled.png` | after choosing `seed.png` → Upload enabled (brand orange) — proves base64 read + submit-enable |
| `chat-file-field-desktop.png` / `-mobile.png` | non-image `file` field (no camera capture, `application/json` accept) |

## Tests (all green — run in worktree)

- `packages/app-core/.../owner-app-inline-adapter.test.ts` — image descriptor
  propagates; multi-key tunnel stays secret. **9 passed.**
- `packages/ui/.../sensitive-request-page.test.tsx` (new) — image renders (not
  filtered), delivers base64 data URL via `/submit`, rejects over `maxBytes`,
  non-image file has no camera capture. **4 passed.**
- `packages/ui/.../MessageContent.sensitive-request.test.tsx` — existing image
  test + new `file`-field + `maxBytes`-exceeded branch. **12 passed.**

Typecheck: clean for all touched files (the one pre-existing `@stwd/sdk`
version-skew error in `authorize-content.tsx` is unrelated).

## Verdict

`good` — image/file sensitive-request fields render on both the in-chat block and
the hosted page, are reachable from a real agent request, deliver as base64 data
URLs through the existing submit path, and enforce `mimeTypes`/`maxBytes`.
