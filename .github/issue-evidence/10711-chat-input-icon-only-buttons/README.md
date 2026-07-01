# #10711 — chat input `+`/mic/send buttons icon-only (no border/background)

**Verdict: `good`** — desktop + mobile, rest + active states.

## What changed

`SoftButton` in `packages/ui/src/components/shell/ContinuousChatOverlay.tsx` (renders the
composer `+`/attach, mic, send, stop controls) is now **icon-only**:

- Removed the resting `rounded-full` capsule, `border`, and `bg-white/10` fill.
- Removed the hover background (`hover:bg-white/20`); hover now changes **icon
  color only** (`text-white/75` → `text-white`).
- Bumped icon size to carry weight without the capsule: lucide `22px → 26px`,
  hand-drawn `Glyph` `26px → 30px` (optically matched across `+`, mic, send, stop).
- Active state (recording / hands-free / transcription) no longer uses the solid
  `bg-white/85` fill — it is distinguished by **accent icon color** (`text-accent`,
  brand orange) with no background/border.
- `h-11 w-11` (44×44) hit target preserved (WCAG 2.5.5); `opacity-40` disabled
  dim and the `aria-disabled` guard are unchanged.

`Glyph` gained an optional `className` so the composer can size it up without
affecting the unrelated "tap to enable sound" glyph.

## Before / after (real-browser, isolated chat-sheet e2e)

Captured with `bun run --cwd packages/ui test:chat-sheet-e2e` (real headless
Chromium, real pointer input), develop vs. this branch:

| state | before | after |
| --- | --- | --- |
| empty composer (peek bar: `+` + mic) | `before-21-state-empty.png` | `after-21-state-empty.png` |
| recording (mic active) | `before-23-state-recording-listening.png` | `after-23-state-recording-listening.png` |
| open sheet, typing → send (`+` + send) | `before-26-typing-send-open.png` | `after-26-typing-send-open.png` |
| responding → stop | `before-51-state-multi-send-while-responding.png` | `after-51-state-multi-send-while-responding.png` |

**Before:** the `+` sits in a bordered circular capsule; the active mic is a
solid **white-filled pill** with a dark glyph. **After:** the `+`, mic, send and
stop controls are clean, borderless, larger icons; the active mic has **no filled
capsule**. In `after-26`, note the composer `+`/send are borderless while the
top-header maximize/copy/reset buttons deliberately keep their chrome — those are
`HeaderButton` (sibling issue L), explicitly out of scope here.

> Note on the active color: the isolated e2e fixture loads Tailwind from the CDN,
> which does not know the project's custom `accent` token, so `text-accent` does
> not tint orange **in this harness only**. In the real app build (`packages/app`
> Tailwind), `text-accent` resolves to brand orange (`255, 88, 0`). The applied
> class is asserted structurally in the unit test below so the guarantee is
> harness-independent.

## Tests

- `packages/ui/src/components/shell/ContinuousChatOverlay.test.tsx` — **91 passed**
  (was 90). Added a durable regression test asserting the resting `+`/mic carry
  **no** `rounded-full`/`border`/`bg-white`, keep `bg-transparent` + `h-11 w-11`,
  and the active mic carries `text-accent` with no reintroduced background/border.
- `bun run --cwd packages/ui test:chat-sheet-e2e` — real-browser overlay states
  green; `0` uncaught page errors, `0` error-level console messages.

## Evidence types

- Before/after screenshots (desktop parity: composer renders identically; mobile
  portrait shown) — **attached**.
- Frontend logs (console clean, `0` errors) — captured by the e2e run.
- Backend logs / real-LLM trajectory — **N/A**: presentation-only CSS change, no
  server/prompt/model path.
- Video walkthrough / electrobun `cursor-screenshot` / native capture — deferred
  to the app audit + device lanes in CI (this is a pure class change to a single
  shared component; the real-browser e2e above is the authoritative proof).
