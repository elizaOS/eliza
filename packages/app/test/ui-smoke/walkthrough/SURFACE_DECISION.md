# Walkthrough surface decision — steps 11–14 (copy / paste / delete)

Resolves the **Open Surface Decision** in [`JOURNEY.md`](./JOURNEY.md). The issue
(#9298) requires this to be decided explicitly, not silently skipped.

## Decision

**Steps 11–14 run on the web `/chat` overlay surface (`ContinuousChatOverlay`).
No surface switch is required for the journey as documented.**

The desktop-only full `ChatView` is targeted **only** if a future step needs a
per-message **edit** or **delete of a sent message** — neither of which the
documented journey requires.

## Why (verified against the code, not assumed)

The `JOURNEY.md` note implied the overlay only has "long-press/tap transcript
copy." Reading the actual component, the overlay's real capabilities are:

| Step | Affordance | Overlay support | Evidence |
|---|---|---|---|
| 11 Copy a message | per-message copy button | **Yes** (assistant messages) | `ContinuousChatOverlay.tsx:52` `canCopy = isAssistant && !!onCopy && message.content.trim().length > 0`; button at `:53-58`; wired `onCopy={handleCopyMessage}` (`:1327` → `handleCopyMessage` `:1057`) |
| 13 Paste into composer | clipboard → composer input | **Yes** (surface-agnostic composer op) | composer is the same on every surface |
| 14 Delete it (draft) | clear composer draft | **Yes** | `JOURNEY.md` step 14 scopes this as draft removal ("If draft-only: composer is empty") |
| — per-message edit | edit a sent message | **No** | overlay exposes no `onEdit` |
| — per-message delete | delete a sent message | **No** | overlay exposes no `onDelete`; the full copy/edit/delete rail lives on the desktop-only `ChatView` (`chat-overlay-controls-interactions.spec.ts:2`) |

So the only affordance the overlay lacks (sent-message edit/delete) is **not on
the journey path**: step 11 copies an **assistant** message, step 13 pastes into
the composer, and step 14 deletes the **draft** — all overlay-native.

## Implementation guidance for `full-walkthrough.spec.ts`

- **Step 11:** target an **assistant** message bubble; click its copy control
  (the `canCopy` button); assert clipboard text equals the message content. Do
  not target a user bubble — `canCopy` is `isAssistant`-gated.
- **Step 13:** seed the clipboard (or reuse step 11's copied text) and paste into
  the composer input; assert the composer value contains it.
- **Step 14:** clear the composer; assert the composer is empty and no pending
  attachment chip remains (the draft-only branch of `JOURNEY.md` step 14).
- **If the journey is later extended** to edit/delete a *sent* message, that step
  must run against desktop `ChatView` (e.g. via the Electrobun harness) and the
  spec must document the surface switch — see the desktop chat specs under
  `packages/app/test/ui-smoke/` (`chat-view-memory-stability.spec.ts`).

## Follow-up

`JOURNEY.md`'s "Open Surface Decision" prose understates the overlay's
per-message copy; when steps 11–14 are implemented, update that section to point
here and to reflect that copy is a first-class overlay affordance, not just
transcript copy.
