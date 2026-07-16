# ChatOverlay — liquid-glass system surface (design spec)

The design spec for `ContinuousChatOverlay.tsx` as a **liquid-glass system
surface**: hierarchy, materials, contrast, motion, focus, scrolling, resize,
reduced-motion, and keyboard/touch. The detent/gesture state machine — the
resting states, transition table, and gesture vocabulary — is the companion
[`__e2e__/CHAT_SHEET_STATE_MATRIX.md`](./__e2e__/CHAT_SHEET_STATE_MATRIX.md);
this document owns the surface's **look and feel** and references the matrix for
behavior rather than restating it.

Binding rule across every dimension: **presentation never stands in for typed
state.** The overlay's openness is one ordered `ChatMode` machine
(`pill → input → half → full`, with `maximized` the full-bleed variant of
`full`); `data-detent` / `data-chat-state` / `data-maximized` mirror it for
tests. Transcript length / message count is content to render, never a signal
for which detent or material to show.

## Hierarchy

One always-present, bottom-anchored element that **never remounts** across
`pill ↔ input ↔ half ↔ full ↔ maximized` — every transition is
transform / opacity / height only (compositor-friendly). Its container is
`pointer-events-none` so the view/wallpaper behind stays live; only the composer
and the open sheet capture input. The composer never moves — the transcript
grows **up** out of it inside the same panel.

- **PILL / INPUT** (rest): just the composer bar (+ grabber). The chat column is
  pinned to `max-w-3xl` in every state and never reflows.
- **HALF / FULL**: the thread reveals above the composer; the status header
  appears at/over the HALF height.
- **MAXIMIZED**: edge-to-edge full-bleed; only the glass (width, side inset,
  corner radius, height cap — driven by the `fullBleedT` motion value 0→1)
  grows to the screen edges. The reading column stays pinned; the grabber is
  replaced by a top restore strip.

No chrome/signage: no message counter, no "new chat", no tab strip. Controls
dissolve into the glass; status is a soft breath of light, not a branded alert.

## Materials — liquid glass, sourced from the token system

The frosted panel is a **system surface**: its material comes from the shared
glass tokens (`glass/tokens.ts`), not a hand-rolled inline recipe. The overlay
imports the exact same constants the `sheet` recipe uses, so token and surface
can never drift:

- **Fill** — `GLASS_SHEET_FILL` = `color-mix(in srgb, var(--card) 62%, transparent)`.
  A mostly-translucent dark card so the live view behind reads as a soft, bright
  frost, not a gray near-opaque slab.
- **Backdrop** — `GLASS_SHEET_BACKDROP_FILTER` = `blur(30px)`. A heavy **neutral**
  blur: it keeps text legible while letting the backdrop's color and light
  through. **No `saturate`** — saturate muddies the warm/orange field to brown
  (measured, not taste); the whole liquid-glass system is neutral white/black
  only. **No refraction** — a panel this size would visibly warp the text behind
  it (refraction is reserved for the small notification cards).
- **Edge** — the shared `LIQUID_GLASS_EDGE_SHADOW` bevel (bright top-left rim over
  a soft bottom-right shade) + `LIQUID_GLASS_SHEEN` specular highlight. Depth is
  inset light, never an outer drop shadow (the shell's flat surface system).

Per-platform tiers are owned by `glass/useNativeGlass.ts`: `native` (real
`UIGlassEffect` on iOS 26+, Material panel on Android 12+, element transparent),
`css-refraction` (Chromium), `css-frosted` (universal). The tier changes only
which layer paints the material — never geometry. Full-bleed is opaque
(`var(--bg)`, no blur): nothing to see through, so the blur would be wasted
battery. The `no-backdrop-blur-gate` test keeps blur confined to this named set
of glass surfaces (#9141 battery).

## Contrast (WCAG-AA)

Self-contained contrast: the overlay ships its own dark, neutral token block
(`CHAT_PANEL_THEME`: `--card #181a20`, `--txt #f4f5f7`, `--muted` 0.68,
`--muted-strong` 0.86) scoped on the fieldset, so text stays legible over any
substrate (bright view, dark view, warm "good evening" field) and the chat never
reads as a transparent orange overlay. Body/muted text clears the AA 4.5:1 floor
over the panel fill; helper text never uses opacity-suffixed muted classes
(`text-muted/70` etc.) — the bar #16418 set. Icon hit targets are 44×44.

## Motion + reduced-motion

Springs: `SHEET_SPRING` (height) `{320, 34, 0.9}`; `OPEN_SPRING` (pill→input
"liquid glass" open, springier) `{300, 26, 0.85}`. Open/close motion is
opacity/translate only — animating blur/filter or scaling the transcript
repaints too much and janks. Maximize is a **discrete** state (shape springs to
full-bleed when the over-pull crosses `MAXIMIZE_COMMIT_T`, back below
`MAXIMIZE_RELEASE_T` — hysteresis), not a finger-tracked lerp of the shape. Each
detent crossing fires one light haptic.

`useReducedMotion()` gates every animation: each reduced-motion path snaps the
motion value instantly (height set directly instead of animated, first-run
backdrop straight to `off`, `fullBleedT`/`openProgress` set not sprung, overlay
fade duration → 0). Pulse indicators use `motion-reduce:animate-none`.

## Focus management

Focus == INPUT intent only. Focusing the composer records the pre-focus state;
typing a **non-empty draft** (a typed-state signal, `draft.trim().length > 0`)
expands to HALF when a thread exists. Keyboard-dismiss (tap grabber / scrim /
outside) returns to the pre-focus state: collapsed-before-focus → INPUT,
open-before-focus → its detent. Every collapse to INPUT/PILL blurs the composer
so the keyboard drops. `Escape` in the transcript collapses the sheet.

## Scrolling

Bottom-follow is delegated to the shadcn `MessageScroller` primitive
(`components/ui/message-scroller.tsx`): it sticks to the bottom **only when the
user is already at the bottom**, so streamed/incoming content never yanks the
viewport when the reader has scrolled up. First-run starts at the top (`start`);
normal chat pins the latest line near the composer (`end`). The only forced
scroll is after an explicit send (`scrollToEnd`). The viewport is
`touch-pan-y overscroll-contain` with a closed horizontal axis; infinite upward
history loads via a top sentinel with the reader's anchor preserved.

## Resize / detents / keyboard / touch

Owned by [`CHAT_SHEET_STATE_MATRIX.md`](./__e2e__/CHAT_SHEET_STATE_MATRIX.md).
Load-bearing invariants: FULL is a ceiling you over-pull past (top always
maximizes); only FULL may carry `maximized`, every other landing clears it;
`openProgress` always settles to 0 (pill) or 1 (anything else), never mid-morph;
1:1 finger tracking at both extremes; travel past the full-bleed ceiling is
consumed, not banked. Keyboard-intrusion resizes the panel to the true visual
viewport and applies the native keyboard lift the visual viewport may under-report.

## State coverage

`empty` (fresh/cleared thread), `loading` (`chat-thread-loading` spinner while
`visibleMessages.length === 0 && conversationLoading`), `error` (send-blocked /
model-unavailable composer states, image read errors), `connected` (live
transcript + turn-status), and `offline` (provisioning / no-provider recovery
gate) each render distinguishably. Loading is never rendered as a broken empty
box; empty is never rendered as loading. Long / adversarial content wraps within
the pinned reading column and scrolls; the composer placeholder never wraps past
two lines.
