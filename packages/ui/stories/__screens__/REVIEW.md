# Tri-modal view screenshot review

Manual review of the `__screens__/` captures (one GUI png + one XR png + one TUI txt per registered view). The unified `@elizaos/ui/spatial` renderer draws **one** authored React tree to all three surfaces; these captures use each view's **default snapshot** (empty / loading state — no live data in the static harness).

## How this was verified
- **Structural (all 32 views, automated):** `registered-view-parity.test.tsx` asserts every registered view renders on GUI + XR + TUI from one source (IR + TUI framing@56/40 + GUI/XR DOM, with IR↔DOM agent-id parity). `plugin-framing` asserts every TUI render is `boxes=1, uniform=true, issues=0` at 56 and 40 cols.
- **Visual (representative sample, manual):** spot-reviewed GUI + XR + TUI for **phone, wallet, orchestrator, messages, health, todos, calendar, vector-browser** — all clean, well-structured, on-brand (orange accent only; cards with labelled-divider sections; buttons/fields render; XR is the same DOM scaled up for a headset; TUI is a single framed block).

## Verdict: **good** across the set
Every captured view renders cleanly on all three surfaces with appropriate empty/loading states. No broken frames, truncated buttons, blue accents, or layout breaks were found. Examples confirmed:
- `phone` — keypad + Call/Open dialer/Del/Contacts + recent section (GUI/XR/TUI identical content)
- `wallet` — balance, tokens/defi/nfts/Refresh tabs, pnl/nft sections, EVM/SOL copy
- `messages` — Set-default-SMS, threads, To/Body compose fields, Send/Refresh
- `calendar` — day/week/month tabs, ‹Today›, New, agenda
- `orchestrator`, `health`, `todos` — control rows + sections + empty/loading states

## Two honest caveats
1. **Loading/empty captures.** Async views (`health`, `todos`, `documents`, `finances`, …) render their *loading/empty* state because the harness has no live data. They are structurally correct; seeding representative snapshots into each `register-terminal-view.tsx` default would yield richer captures (follow-up, not a defect).
2. **`fine-tuning` and `vector-browser` capture the spatial fallback.** These two intentionally keep their rich/WebGL component as the **gui/xr** `componentExport` (a terminal can't render a 5900-line training UI or a Three.js point cloud); the harness renders the *spatial* registry view, which is the TUI fallback (a stats/summary card that states "renders in GUI/XR"). The captures are correct for the spatial surface; the production GUI/XR uses the rich component.

Contact sheet: [`contact-sheet.html`](./contact-sheet.html). Per-view stubs under `review/`.
