# Full Walkthrough Journey

Issue: #9298

This document is the source of truth for the full app walkthrough spec. The
future `full-walkthrough.spec.ts` should drive these states in order, capture a
screenshot for each state, and assert the DOM, route, console, and network
conditions listed here. Existing smoke tests cover many of these flows in
isolation; the walkthrough joins them into one continuous journey.

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
  - Onboarding shell: `[data-testid="onboarding-toast"]`
  - Springboard: `[data-testid="springboard"]`
  - Springboard tiles: `[data-testid^="springboard-tile-"]`
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
- `springboard-interaction.spec.ts` covers Springboard tiles, paging, edit mode,
  and tap-to-launch.
- `view-switching-chat-e2e.spec.ts` covers chat-command view switching.

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
| 1 | Cold app launch | The app shell loads from `/` without first-run completion. A warming or startup surface renders, then the first-run onboarding shell appears. | No page errors; no unexpected `console.error`; no unexpected `5xx`; `[data-testid="onboarding-toast"]` visible within 20s when first-run is incomplete. | `01-cold-launch.png` |
| 2 | Onboarding | `CompactOnboarding` shows the runtime choice question and all runtime cards available for the current host capability. | Text `How should Eliza run?`; `onboarding-option-cloud`, `onboarding-option-remote`, and `onboarding-option-local` visible; disabled state is asserted when host capability requires it. | `02-onboarding-runtime.png` |
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
| 19 | Swipe to Springboard of views | The home/springboard surface shows the view grid. | `/views` or the internal springboard page is active; `[data-testid="springboard"]` visible; at least one `[data-testid^="springboard-tile-"]` visible. | `19-springboard.png` |
| 20 | Click another view | A Springboard tile launches a real view. | Click the first visible tile button; URL leaves `/views`; the target route's ready selector from `apps-session-route-cases.ts` or visible heading appears. | `20-launch-view.png` |
| 21 | Open chat | The chat overlay opens over the current view without remounting the view. | Current view marker remains visible behind/around the overlay; overlay `data-open="true"`; composer can send or receive focus. | `21-chat-over-view.png` |
| 22 | Back to dashboard | The app returns to home/dashboard and leaves chat at its rest detent. | Home/dashboard or springboard home pane visible; overlay collapsed; no page diagnostics accumulated through the journey. | `22-dashboard-rest.png` |

## Validation Checklist

- Every step captures screenshot, DOM state, console errors, failed network
  responses, URL, and viewport size.
- Every screenshot has a corresponding assertion row in this document; no
  captured state is accepted on sight alone.
- The spec runs at desktop and at least one mobile viewport, or the PR explains
  why a step is desktop-only.
- The final PR includes contact sheet/video links and marks every `PR_EVIDENCE`
  row as attached or N/A with a reason.
