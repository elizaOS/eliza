# Evidence — #10720 desktop experience: chat-first launch + in-chat onboarding + lifecycle

Branch: `docs/10720-desktop-experience`

## Finding: the two architectural asks are already the shipped default

A read of the shell confirmed both #10720 "architecture" requirements are the
current code default — this PR **documents and regression-guards** them (the
missing deliverable was the doc + a contract test), rather than re-implementing.

| Requirement | Already default in code | Where |
| --- | --- | --- |
| Chat opens by default; the full app window does **not** auto-open | `shouldStartBottomBar()` returns `true` (#10350); `createMainWindow` appends `?shellMode=chat-overlay` → renderer mounts `ChatOverlayShell` (bar + overlay only) | `desktop-bottom-bar-config.ts`, `index.ts`, `packages/ui/src/App.tsx` |
| Onboarding runs conversationally **in the chat**, not a separate window | `use-first-run-conductor.ts` seeds onboarding turns into the live transcript; `App.tsx` paints the shell during `first-run-required` | `packages/ui/src/first-run/use-first-run-conductor.ts`, `App.tsx` |
| Deep-link routing into the right surface | `classifyDeepLinkRoute()` — pure, case-insensitive, unit-tested (#10770) | `desktop-deep-link-events.ts` |

## Delivered here

- **`docs/desktop-window-lifecycle.md`** — the desktop architecture doc the issue
  asked for: chat-first launch, in-chat onboarding, view summoning
  (tray / menu / deep link / hotkey), tray + focus/restore + single-instance,
  and the env knobs. Matches shipped behavior.
- **`desktop-experience-contract.test.ts`** — 10 assertions pinning the doc's
  promises so a regression that flips chat-first launch, the tray defaults, or
  the kiosk override fails CI.

## Tests (`contract-tests.log`)

`desktop-experience-contract.test.ts` (10, NEW) + `desktop-deep-link-events.test.ts`
+ `desktop-bottom-bar-config.test.ts` — **30 passing**.

## Full-shell e2e + cursor-screenshot capture

**Deferred to a human on a built desktop app** (per `PR_EVIDENCE.md`). Driving the
real Electrobun window via the `/api/dev/*` loopback (`dev/stack`,
`dev/cursor-screenshot`, `dev/console-log`) and capturing the chat-first launch +
in-chat onboarding walkthrough requires a running desktop build and OS-level
screenshots, which can't be produced headlessly. Recipe: build + launch the
desktop app, confirm it opens the bottom-bar chat (not the dashboard), complete
onboarding in-chat, then `GET /api/dev/cursor-screenshot` before/after. The
behavior these prove is enforced by the contract test above.

Real-LLM trajectory: **N/A** — window/lifecycle wiring; onboarding content is
covered by the runtime's own first-run scenarios.
