# Manual review — first-run onboarding (#12368 WI-7)

**Nature of this WI:** #12368 is the *audit + evidence* work item that closes the
#12178 onboarding program. Every implementation sibling (#12363 wizard-state
deletion, #12364 opaque onboarding backdrop, #12365 composer unlock, #12367
in-chat model status) is **already merged into `develop`**. This review audits
the real merged onboarding stack and records the verdict; it does **not** ship a
new UI fix — the fix already landed. No production code is changed by this PR.

Design-review harness: `bun run --cwd packages/app design-review --view=first-run`
(headless, mock API, `firstRunComplete=false`, the real `ContinuousChatOverlay`
seeded by the live `use-first-run-conductor`). Captures: 6 viewports × 2 states
(runtime chooser + provider picker after "On this device").

Screenshots: `../design-review/before/*.png` (pre-#12364 develop, translucent
scrim) and `../design-review/after/*.png` (post-#12364 develop, opaque backdrop).

## F1 — full-screen opaque onboarding backdrop (VERIFIED good on develop)

**Before (pre-#12364).** The first-run chat overlay sat over the steady-state
dimming scrim — a gradient topping out at 0.78 opacity — so the launcher/home
(clock, weather, "Welcome — ask me anything", the suggestion strip, "Loading…",
the "Waking Eliza…" pill) bled through the onboarding sheet and, worse, through
the transcript itself:

- `before/desktop-landscape--first-run-local.png` — home "Welcome…", suggestion
  strip and "Loading…" are legible behind the runtime-chooser transcript.
- `before/mobile-portrait--first-run-local.png` — home content overlaps the
  onboarding copy; the "Waking Eliza…" pill collides with the "Weather" label.
- `before/mobile-landscape--first-run-local.png` — the "10:10 PM" clock and
  weather widget read straight through the choice rows.
- `before/ipad-portrait--default.png` — the sheet covered only the bottom ~35%,
  so onboarding read as a bottom sheet, not the "full-screen start" #12178 wants.

**After (#12364 on develop).** While `firstRunOpen`, `ContinuousChatOverlay`
renders `chat-first-run-backdrop` — an opaque `bg-bg` layer, `fixed inset-0`,
`data-first-run-opaque="true"`, painted at opacity 1 above the gradient scrim and
below the glass panel. `firstRunBackdrop` initializes to `"opaque"` on
`firstRunOpen` and a guarded effect re-forces `"opaque"` on every onboarding
render, so the launcher is fully hidden for the whole flow; on completion it
fades opaque→transparent over ~400ms in step with the one-shot auto-collapse
(cut under `prefers-reduced-motion`), which is the designed graceful exit into
the launcher.

Because that dedicated opaque layer already covers the full viewport, the
translucent scrim beneath it is completely occluded during onboarding — there is
**no residual bleed-through to fix**, and no second opaque layer is warranted.

- `after/desktop-landscape--first-run-local.png` — solid backdrop; no home bleed;
  transcript + provider choices fully legible.
- `after/mobile-portrait--first-run-local.png` — clean full-screen onboarding.
- `after/ipad-portrait--default.png` — solid full-screen start.

Independent pixel proof already committed on develop (from #12364/#12470):
`packages/ui/src/components/shell/__e2e__/output/57-state-onboarding-opaque-backdrop.png`
— a fully opaque dark backdrop with the unlocked composer ("Ask me anything —
or pick an option") and a typed message in the transcript.

**Verdict (develop, all viewports): good.**

| Viewport | default (runtime chooser) | first-run-local (provider) |
|---|---|---|
| mobile-portrait | good | good |
| mobile-landscape | good | good |
| desktop-landscape | good | good |
| ipad-portrait | good | good |
| ipad-landscape | good | good |
| chat-shell-breakpoint | good | good |

> Note on the `after/*` captures: they were taken from a branch that carried a
> now-dropped redundant scrim-opacity tweak, so their composer still reads the
> old "Pick an option to continue" placeholder. The opaque backdrop they show is
> identical to develop's `chat-first-run-backdrop`; develop's own committed
> `57-state-onboarding-opaque-backdrop.png` is the authoritative post-merge
> capture and shows the unlocked "Ask me anything — or pick an option" composer.

## Behavioral scope — sibling features, all on develop

The parent issue's behavioral items are shipped by the merged siblings, not
blocked:

- **Typing while not ready (#12365).** The `message` textarea is unlocked during
  first-run (`disabled=false`, placeholder "Ask me anything — or pick an
  option"); typed text is answered by the conductor's local echo persona via the
  shared `sendActionMessage` funnel and never reaches the server. Attach + mic
  stay inert (no agent to serve media yet). Covered by
  `ContinuousChatOverlay.firstrun.test.tsx` ("unlocks the composer text…",
  "routes composer free text to the in-chat conductor…", "answers Enter-typed
  free text through the conductor funnel…").
- **In-chat model download status (#12367).** The composer placeholder reflects
  live `modelStatus`: "Downloading <model> — you can keep typing" / "Getting
  <model> ready — you can keep typing" — the status is in-chat, not a home widget
  hidden behind the full-screen sheet.
- **`MODEL_SWITCH` / `AGENT_SWITCH`.** Real actions exist
  (`plugins/plugin-app-control/src/actions/model-switch.ts`, `agent-switch.ts`),
  routed through `POST /api/runtime/model-switch` and
  `packages/agent/src/api/runtime-switch-routes.ts`, broadcasting `shell:*`
  events to connected shells. Sanctioned models only (curated Eliza-1 catalog +
  `DEFAULT_ELIZA_CLOUD_TEXT_MODEL`).

The **mock-API design-review harness seeds only the choice-picker turns**, so it
cannot itself drive a real background model download, a cancel/retry, or a live
cloud/local switch — those need a live runtime, not this pixel harness. Those
rows are N/A-with-reason in the PR evidence checklist; each behavior's real proof
lives in the sibling PR that shipped it.

## Color / hover rules

- Orange is accent-only: the recommended provider ("On this device
  (recommended)") is the sole orange-filled control; unselected choices are
  neutral. No blue anywhere. Compliant.
- Hover: the choice rows are `ChoiceWidget` buttons, not the primary-button hover
  the `audit:app` project probes; they have no orange-resting → black hover to
  violate. N/A for this view.

## Residual (pre-existing, not in WI-7 scope)

- The orange recommended-provider button clips its trailing chevron on the
  narrowest mobile widths (`On this device (recommended) >` — the `>` is partly
  cut). A `ChoiceWidget` label-width issue, present before and after the backdrop
  work; flagged for the ChoiceWidget owner. Does not block this verdict.
