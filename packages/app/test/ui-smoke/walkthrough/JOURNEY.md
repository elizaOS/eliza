# Full Walkthrough Journey

Issue: #9298 (spec built in #10198 / #10204)

This document is the source of truth for the full app walkthrough spec. That
spec now exists: **`full-walkthrough.spec.ts`** drives these states in order,
captures a `NN-<step>.png` screenshot for each state, and asserts the DOM,
route, console, and network conditions listed here. Existing smoke tests cover
many of these flows in isolation; the walkthrough joins them into one continuous
journey.

> **Built (#10198 / #10204).** The asked-for narrative — cold launch →
> onboarding → tutorial → help → settings → wallet → real chat → view-switch →
> settings-edit → dashboard — is the **Extended Journey** table at the bottom of
> this file (25 steps), which supersedes the original 22-state table (kept for
> history). Drive + capture + review + record it with one command:
>
> ```bash
> bun run --cwd packages/app test:e2e:walkthrough          # keyless mock lane
> bun run --cwd packages/app test:e2e:walkthrough:live     # real backend + model
> bun run --cwd packages/app test:e2e:walkthrough:ios      # iOS sim leg + capture
> bun run --cwd packages/app test:e2e:walkthrough:android  # Android emu/device leg
> ```
>
> Per-step vision verdicts: [`WALKTHROUGH_VERDICTS.md`](./WALKTHROUGH_VERDICTS.md).
> Platform matrix + prereqs + skip reasons: [`DEVICE_MATRIX.md`](./DEVICE_MATRIX.md).
> Generated artifacts (screenshots, logs, trajectory, stitched recording) land
> gitignored under `reports/walkthrough/<runId>/` and
> `e2e-recordings/app/walkthrough/<runId>/`.

## Harness Baseline

- Use `installDefaultAppRoutes(page)` and `seedAppStorage(page)` unless a step
  explicitly needs first-run state.
- Install page diagnostics before navigation and fail on unhandled `pageerror`,
  unexpected `console.error`, and unexpected `5xx` responses.
- Prefer stable selectors already used by smoke tests:
  - Chat overlay: `[data-testid="continuous-chat-overlay"]`
  - Chat sheet: `[data-testid="chat-sheet"]`
  - Chat grabber: `[data-testid="chat-sheet-grabber"]`
  - Composer: `[data-testid="chat-composer-textarea"]`
  - Send: `[data-testid="chat-composer-action"]`
  - Chat thread lines: `[data-testid="thread-line"]`
  - First-run setup: assert the shell overlay plus
    `[data-testid="continuous-chat-overlay"]`; runtime choices use
    `[data-testid="choice-__first_run__:runtime:<id>"]`, the provider step uses
    `[data-testid="choice-__first_run__:provider:<id>"]`, and the
    completion gate remains
    `[data-testid="choice-__first_run__:tutorial:start|skip"]`
  - Tutorial: `/tutorial` route → `[data-testid="tutorial-launcher"]` →
    `[data-testid="tutorial-start"]` → `[data-testid="tutorial-card"]`
  - Launcher: `[data-testid="launcher"]`
  - Launcher tiles: `[data-testid^="launcher-tile-"]`
  - Character editor: `[data-testid="character-editor-view"]`
- Record with `E2E_RECORD=1 bun run --cwd packages/app test:e2e:record` after
  the spec is automated, then regenerate contact sheets/viewer if needed.

## Existing Coverage To Reuse

- `first-run-startup.spec.ts` covers fresh first-run onboarding and runtime
  choice rendering.
- `cloud-provisioning-startup.spec.ts` and `warming-shell-startup.spec.ts`
  cover startup/provisioning readiness.
- `tts-stt-e2e.spec.ts` covers browser STT and cloud TTS wiring with mocks.
- `chat-overlay-controls-interactions.spec.ts` covers overlay open/collapse,
  Escape, backdrop, selectable transcript text, and attachment picker.
- `conversation-management.spec.ts` covers send + reload persistence on the
  real overlay surface.
- `chat-large-paste.spec.ts` covers paste-to-attachment behavior.
- `settings-sections-interactions.spec.ts` has a live-only character bio
  write/reload/read-back path.
- `launcher-interaction.spec.ts` covers Launcher tiles, paging, edit mode,
  and tap-to-launch.
- `view-switching-chat-e2e.spec.ts` covers chat-command view switching.
- `walkthrough/walkthrough-capture-smoke.spec.ts` covers an early, keyless
  capture path for onboarding, chat send/receive, full chat detent, Launcher,
  and launching a view. It is not the full 22-step journey; it records named
  screenshots only when run through the existing `E2E_RECORD=1` harness.

## Open Surface Decision

The web `/chat` route is overlay-only. The desktop-only full `ChatView` owns the
per-message copy/edit/delete rail; `ContinuousChatOverlay` currently supports
long-press/tap transcript copy but not the full rail. Step 11 through step 14
must choose one of these paths before automation:

- Target desktop `ChatView` for the copy/delete section and document that the
  walkthrough switches surfaces.
- Or add equivalent copy/delete affordances to the overlay, then keep the entire
  journey on the primary web/mobile surface.

Do not skip these steps silently. The chosen path must be visible in screenshots
and named in the final evidence.

## Journey States

| Step | Action | Expected state | Required assertions | Capture |
| --- | --- | --- | --- | --- |
| 1 | Cold app launch | The app shell loads from `/` without first-run completion. A warming/startup surface renders, then the home + chat transcript first-run choices appear. | No page errors; no unexpected `console.error`; no unexpected `5xx`; `[data-testid="continuous-chat-overlay"]` + transcript runtime choices visible within 20s when first-run is incomplete. | `01-cold-launch.png` |
| 2 | Onboarding | The chat transcript owns runtime/provider setup. | Runtime prompt visible; `choice-__first_run__:runtime:cloud`, `:local`, and `:remote` visible (no `:other`). | `02-onboarding-runtime.png` |
| 3 | Agent provisioning | Choosing the selected runtime leads to a provisioning or ready state; the app does not stay stuck on waking/provisioning copy. | Status changes are observed through the real startup/provisioning selectors used by existing smoke tests; ready route eventually exposes the chat composer. | `03-provisioning-ready.png` |
| 4 | Send + receive voice | Voice input can populate the composer, a message can be sent, the assistant reply renders, and TTS endpoint wiring is exercised when enabled. | STT transcript appears in `[data-testid="chat-composer-textarea"]`; stream POST body includes the transcript; assistant `[data-testid="thread-line"]` appears; TTS mock records assistant text + voice/model payload. | `04-voice-round-trip.png` |
| 5 | Type to navigate to Character view | A chat command switches the active route to the character editor. | Composer sends the command; navigation reaches `/character`; `[data-testid="character-editor-view"]` visible. | `05-chat-navigate-character.png` |
| 6 | Edit character | The Personality panel opens, the `About Me` field accepts a unique text edit, Save persists it, and reload reads the same value back. | `Open Personality` button visible; `About Me` textbox or placeholder `Describe who your agent is` visible; `PUT /api/character` observed in live mode; reload shows the unique value. | `06-character-edit-persist.png` |
| 7 | Pull chat up / maximize | The overlay opens from rest to a full-height detent. | `[data-testid="continuous-chat-overlay"]` has `data-open="true"`; `[data-testid="chat-sheet"]` reaches `data-detent="full"` and, when the maximize control is used, `data-maximized="true"`. | `07-chat-full-detent.png` |
| 8 | New chat | A fresh conversation is created without losing the prior thread. | New conversation control or API call creates a new conversation; prior conversation remains selectable through the conversation surface/API; composer is empty for the new thread. | `08-new-chat.png` |
| 9 | Press home | The app exits full chat and returns to the home/dashboard surface with the chat collapsed. | URL or shell state indicates home/dashboard; chat overlay no longer has `data-open="true"` or `chat-sheet` returns to collapsed/pill. | `09-home-from-chat.png` |
| 10 | Swipe back to last chat | Conversation navigation restores the previous thread and scroll position. | Previous user and assistant `[data-testid="thread-line"]` entries are visible after switching; scroll offset is within an asserted tolerance of the saved value. | `10-restore-last-chat.png` |
| 11 | Copy a message | The selected surface exposes a copy affordance and copies message text. | If targeting overlay: long-press/tap copy shows `thread-line-copied` or clipboard text. If targeting desktop `ChatView`: action rail copy button visible and clipboard text matches. | `11-copy-message.png` |
| 12 | Swipe back to new chat | The journey returns to the new thread after copying from the previous thread. | New thread is active; previous copied text is not rendered as a message unless explicitly pasted. | `12-return-new-chat.png` |
| 13 | Paste into composer | Clipboard content lands in the composer or, for large text, becomes a collapsed text attachment. | Normal text: composer value equals copied text. Large text: `pasted-text.md` chip visible and composer remains short, matching `chat-large-paste.spec.ts`. | `13-paste-composer.png` |
| 14 | Delete it | The pasted draft/message is removed and state remains consistent. | If draft-only: composer is empty and no pending attachment chip remains. If sent message: delete affordance succeeds and the thread/API no longer returns that message. | `14-delete-paste.png` |
| 15 | Pull chat down to a pill | The overlay collapses to the pill/input rest state. | `[data-testid="chat-sheet"]` has `data-detent="pill"` or overlay lacks `data-open="true"` while composer remains reachable. | `15-chat-pill.png` |
| 16 | Pull back up to full width | The overlay expands from pill/rest back to the full-width/full-height state. | Grabber or keyboard gesture opens chat; overlay `data-open="true"`; `[data-testid="chat-sheet"]` has `data-detent="full"`; thread visible. | `16-chat-full-again.png` |
| 17 | Click into input | Composer receives focus and keyboard-aware state is applied. | `document.activeElement` is the composer; chat remains open or opens to the keyboard detent; no layout overlap around composer. | `17-input-focused.png` |
| 18 | Pull down to just the input | The chat history hides while composer/input remains visible. | `chat-sheet` detent is collapsed or input-only; `[data-testid="chat-composer-textarea"]` visible; thread content either hidden or clipped above composer by design. | `18-input-only-detent.png` |
| 19 | Swipe to Launcher of views | The home/launcher surface shows the view grid. | `/views` or the internal launcher page is active; `[data-testid="launcher"]` visible; at least one `[data-testid^="launcher-tile-"]` visible. | `19-launcher.png` |
| 20 | Click another view | A Launcher tile launches a real view. | Click the first visible tile button; URL leaves `/views`; the target route's ready selector from `apps-session-route-cases.ts` or visible heading appears. | `20-launch-view.png` |
| 21 | Open chat | The chat overlay opens over the current view without remounting the view. | Current view marker remains visible behind/around the overlay; overlay `data-open="true"`; composer can send or receive focus. | `21-chat-over-view.png` |
| 22 | Back to dashboard | The app returns to home/dashboard and leaves chat at its rest detent. | Home/dashboard or launcher home pane visible; overlay collapsed; no page diagnostics accumulated through the journey. | `22-dashboard-rest.png` |

## Validation Checklist

- Every step captures screenshot, DOM state, console errors, failed network
  responses, URL, and viewport size.
- Every screenshot has a corresponding assertion row in this document; no
  captured state is accepted on sight alone.
- The spec runs at desktop and at least one mobile viewport, or the PR explains
  why a step is desktop-only.
- The final PR includes contact sheet/video links and marks every `PR_EVIDENCE`
  row as attached or N/A with a reason.

## Extended Journey (the spec that ships)

`full-walkthrough.spec.ts` drives the rows below in order, at the desktop
(1440×1000) **and** mobile (390×844) viewports. Each row maps 1:1 to a captured
`NN-<step>.png` and a `NN-<step>.json` manifest (URL, viewport, DOM markers,
per-step console/network diagnostics, the assertions that passed). This table
extends the original 22 states with the asked-for **tutorial / help / settings /
wallet / settings-edit** rows so no captured state is accepted "on sight."

Lanes: the **mock** lane (default, keyless) page-mocks the conversation store so
chat is deterministic; the **live** lane (`--live`,
`ELIZA_UI_SMOKE_LIVE_STACK=1`) installs no conversation mock, so step 08 drives
the real backend agent + model and writes the trajectory to
`reports/walkthrough/<runId>/<viewport>/trajectory/chat-step.json`. Rows marked
**live-persist** assert real persistence (`PUT /api/character` / `PUT /api/config`
+ reload read-back) only in the live lane; the mock lane still captures them.

| Step | Action | Expected state | Required assertions | Capture |
| --- | --- | --- | --- | --- |
| 01 | Cold app launch | `/` loads with first-run incomplete; the chat transcript renders first-run choices over the app shell. | No page error / no `console.error` / no 5xx; `continuous-chat-overlay` + transcript choices visible ≤20s; removed `first-run-chat`/`startup-first-run-background` absent. | `01-cold-launch.png` |
| 02 | Onboarding runtime choice | The chat transcript asks how the agent should run. | Runtime prompt visible; `choice-__first_run__:runtime:cloud` / `:local` / `:remote` visible (no `:other`). | `02-onboarding-runtime.png` |
| 03 | Choose runtime → tutorial → ready | Picking Local advances to the provider step, then provisioning, then the tutorial-or-skip CHOICE flips first-run complete. | `choice-__first_run__:runtime:local` → `choice-__first_run__:provider:on-device` → `choice-__first_run__:tutorial:skip`; first-run flips complete; `continuous-chat-overlay` + `chat-composer-textarea` reachable. | `03-provisioning-ready.png` |
| 04 | Interactive tutorial | The `/tutorial` launcher starts the tour spotlight. | `tutorial-launcher` → `tutorial-start` → `tutorial-card`; "Meet Eliza" text visible; tour dismissed via `tutorial-skip`. | `04-tutorial.png` |
| 05 | Help search | The Help view searches the KB. | `help-view` visible; search "change the model" → `help-entry-change-model` references "AI Model". | `05-help.png` |
| 06 | Open settings | The Settings shell opens. | `settings-shell` visible; "Models & Providers" section opened. | `06-settings-open.png` |
| 07 | Wallet view | The Wallet view renders. | `wallet-shell` (or Wallet heading) visible at `/wallet`. | `07-wallet.png` |
| 08 | Chat a conversation | A real round-trip: user line + assistant reply. | user `thread-line` visible; assistant `thread-line` visible & non-empty; **live**: reply from the real model (trajectory captured). | `08-chat-round-trip.png` |
| 09 | Maximize chat | Overlay expands to full detent. | desktop: `chat-sheet` `data-detent=full` + `data-maximized=true`; mobile: overlay `data-open=true` (no separate maximize). | `09-chat-full-detent.png` |
| 10 | Navigate to character editor | Chat-driven navigation reaches `/character`. | URL `/character`; `character-editor-view` visible. | `10-chat-navigate-character.png` |
| 11 | Edit character personality | Personality panel opens; About Me edited. | field filled; **live-persist**: `PUT /api/character` + reload read-back matches. | `11-character-edit.png` |
| 12 | Start a new chat | Fresh conversation; composer empty. | new conversation created; composer value empty for the new thread. | `12-new-chat.png` |
| 13 | Return home from chat | Home/dashboard shows, chat collapsed. | `widget-host-home` / `home-launcher-surface` visible; overlay not `data-open=true`. | `13-home-from-chat.png` |
| 14 | Restore the conversation | Reopening chat restores the prior thread. | `continuous-chat-overlay` visible; prior `thread-line` restored. | `14-restore-chat.png` |
| 15 | Copy a message | A message exposes selectable/copyable text. | `data-chat-selectable="true"` (or message text) captured. | `15-copy-message.png` |
| 16 | Paste large text → attachment | Large paste collapses to a `pasted-text.md` chip. | clipboard paste event dispatched; `pasted-text.md` chip visible; composer value stays short. | `16-paste-large.png` |
| 17 | Clear the draft | Draft cleared, no pending chip. | composer value empty. | `17-clear-draft.png` |
| 18 | Collapse chat to the pill | Overlay collapses to rest while composer stays reachable. | overlay no longer `data-open=true` (or composer reachable at rest). | `18-chat-pill.png` |
| 19 | Re-open chat to full | Overlay expands back to open. | overlay `data-open=true`. | `19-chat-full-again.png` |
| 20 | Focus the composer | Clicking the composer focuses it. | `document.activeElement` is the composer textarea. | `20-input-focused.png` |
| 21 | Open the view launcher | Launcher grid shows. | `launcher` visible; ≥1 `launcher-tile-*`. | `21-launcher.png` |
| 22 | Launch a view | A tile launches a real view. | first tile clicked; URL leaves `/views`. | `22-launch-view.png` |
| 23 | Open chat over the view | Focusing the composer opens chat over the launched view without remounting it. | composer reachable over the view; `continuous-chat-overlay` present; route still on the view. | `23-chat-over-view.png` |
| 24 | Edit a setting (persist + read-back) | A settings toggle changes and persists. | Capabilities → `capability-wallet` `aria-checked` flips; **live-persist**: `PUT /api/config` + reload read-back. | `24-settings-edit.png` |
| 25 | Back to dashboard | App returns home; no diagnostics accumulated. | home surface visible; gate (page/console errors + 5xx) clean over the whole journey. | `25-dashboard-rest.png` |
