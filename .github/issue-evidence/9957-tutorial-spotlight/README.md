# #9957 — tutorial spotlight: theme-aware accent, registered z-index, e2e coverage

Fixes the reported "messed-up highlights and colors": the tour spotlight
hardcoded brand orange (`#FF5800` / `rgba(255,88,0,…)` / `#D44A00`) and a
near-black card skin, so in non-orange themes the glow + Continue button stayed
orange over a white/black/gold UI. It also escaped the registered z-scale with an
inline max-int z-index and could ring an off-screen duplicate control. The tour
had **zero** automated coverage.

## What changed

- `TutorialSpotlight.tsx` — every color now reads a theme token: static glow
  `rgba(var(--accent-rgb), …)`, breathing `tutorial-glow` keyframes
  `rgba(var(--accent-rgb), α)`, Continue button `var(--accent)` →
  `var(--accent-hover)` with `var(--accent-foreground)` text, card skin
  `bg-card text-card-foreground border-border`. `const BRAND` deleted.
- `base.css` — added `--accent-rgb` to the `.theme-cloud` / `.theme-os` (white)
  and `.theme-app` / `.theme-clouds` (black) blocks, which previously inherited
  the orange `255, 88, 0`, so the keyframe path is correctly themed everywhere.
- `floating-layers.ts` — new `Z_TUTORIAL = 9500` (above `Z_SHELL_OVERLAY`, below
  `Z_SYSTEM_CRITICAL`); the spotlight consumes it instead of `2147483000`.
- `measure()` — resolves the first **on-screen** match (skips hidden/off-canvas
  duplicates of a reused test id) and surfaces a missing target via
  `data-tutorial-target-missing` instead of silently full-dimming.
- `tutorial-steps.ts` — two new frames (`new-chat`, `swipe-between-chats`)
  targeting real controls (`shell-new-chat`, `chat-sheet`), auto-advancing on a
  new conversation id / a conversation-index change (surfaced on the chat-sheet
  as `data-conversation-id` / `data-conversation-index`). Stale "Tutorial tile"
  copy removed from `tutorial-steps.ts` + `help-content.ts`.

## Evidence (regenerate: `bun run --cwd packages/ui test:tutorial-e2e`)

The e2e mounts the real `TutorialSpotlight` over a chat scaffold and asserts, per
theme, that the glow == the themed `--accent-rgb` and the Continue button == the
themed `--accent`:

| theme | `--accent-rgb` | glow | Continue |
|-------|----------------|------|----------|
| dark  | `255, 88, 0`   | orange (`01-dark-open-chat.png`) | `255,138,36` |
| light | `255,255,255`  | **white, not orange** (`02-light-open-chat.png`) | white |
| gold  | `240,185,11`   | gold (`03-gold-open-chat.png`) | gold |

- `12..19-mobile-*.png` — all 8 frames at mobile (welcome → open-chat →
  resize-chat → ask-to-navigate → use-voice → **new-chat** → **swipe-between-chats**
  → done).
- `desktop-open-chat.png` — desktop frame.
- `tutorial-walkthrough-mobile.webm` — single mobile walkthrough of all 8 frames.

Per-frame the e2e also asserts: spotlight z-index is `9500` (not max-int); the
glow rect frames the on-screen target (Δ ≤ 2px), including when a duplicate
`chat-composer-action` exists off-screen (2 in DOM, 1 on-screen, glow on the
visible one); zero page errors.

Unit coverage: `tutorial-steps.test.ts` — frame order incl. the two new frames,
no stale "Tutorial tile" copy, the new auto-advance predicates, and the
per-frame nav-lock (each frame permits its own tabs + `navigateOnDone`, blocks an
off-path tab).
