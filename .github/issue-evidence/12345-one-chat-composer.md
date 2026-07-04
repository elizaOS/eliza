# #12345 — One push-to-talk core + slimmer ChatComposer control surface

Parent: #12188 (chat/touch/gesture UI consolidation).

## What changed

The continuous chat overlay (`ContinuousChatOverlay.tsx`) and the composite
`ChatComposer.tsx` each hand-rolled the **same** press-and-hold push-to-talk
state machine with **divergent hold timings** (overlay 200ms, composer 180ms)
and duplicated pending/holding/suppress-click logic. Extracted a single
`usePushToTalk` hook (`packages/ui/src/hooks/usePushToTalk.ts`) — one
`PUSH_TO_TALK_HOLD_MS = 200` — that both surfaces consume. The hook owns the
`idle → pending → holding → idle` machine, pointer capture, slide-off cancel,
quick-tap passthrough, click-suppression, and unmount cleanup; each surface
supplies only its `canBegin` guard and start/finish callbacks.

Also dropped the dead `toggleListening` field from `ChatComposerVoiceState`: it
was declared on the composer's voice control surface but never read inside the
composer (voice is driven via `startListening`/`stopListening`). Call sites now
pass only the real control surface.

## Evidence

| Type | Status |
|---|---|
| Unit tests — new `usePushToTalk` machine | `12345-usePushToTalk-tests.txt` — 5 passed (hold-then-submit, quick-tap passthrough, slide-off cancel + no-leak, canBegin=false, non-primary button) |
| Unit tests — composer + ChatView regressions | `bun run --cwd packages/ui test <composer/chat-view/PTT specs>` — 12 passed |
| Unit tests — overlay (166 specs incl. fuzz/slash/firstrun) | 166 passed after refactor |
| L3 push-to-talk / voice walkthrough video | `12345-overlay-voice-*.png` keyframes + `packages/ui/src/components/shell/__e2e__/output-voice-recording/voice-trajectories.webm` (gitignored binary; keyframes tracked) — real Playwright pointer input against the refactored overlay mic; idle → listening → responding → speaking → open-thread all render correctly |
| Typecheck (packages/ui) | No errors in touched files; pre-existing cloud-ui/RoutingMatrix React-types-skew errors are unrelated (present on develop) |
| Biome lint (touched files) | Clean |
| `bun run --cwd packages/app audit:app` | N/A — no `packages/app/` view changed; ChatComposer surfaces are ChatView (desktop detached windows) + overlay (homescreen), both exercised by the voice-trajectory recorder above. The audit:app lane covers `packages/app` views, none of which were touched. |

## Scope honesty

This phase lands the two clean, verifiable consolidations the issue names
directly: **one push-to-talk machine** (removing the duplicated hold timings)
and **slimming the composer control surface** (dead `toggleListening`). A full
replacement of the overlay's deeply-inlined 5,000-line textarea/sheet composer
with the `ChatComposer` component, and folding `ChatSurface`'s glass-button
mini-composer into it, are NOT done here: the overlay's composer is bound to the
sheet-geometry/dictation model and `ChatSurface` uses a deliberately-separate
glass treatment on a shell-controller string-callback contract (the glass
composer split is documented as intentional in the #12188 research). Merging
those is a multi-thousand-line rewrite that needs live-device video across all
three platforms to verify safely, which is out of reach headlessly. See PR body
gaps.
