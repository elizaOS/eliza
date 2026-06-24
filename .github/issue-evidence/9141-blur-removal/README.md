# #9141 — remove backdrop-blur + shadows for battery efficiency

`backdrop-filter` (the glassmorphic "liquid glass" blur) is the single biggest
GPU/battery cost in the UI: the compositor must continuously **re-sample the
backdrop** even on *static* elements, and re-rasterize the blur **every frame**
on anything that moves (the dragged chat sheet, scrolling surfaces). Per the
product decision, all `backdrop-filter` (blur / saturate / brightness) and all
decorative box/drop shadows are removed app-wide.

## What changed

- **81 `backdrop-filter`** occurrences removed across **71 files** (every
  `backdrop-blur*`, `backdrop-saturate*`, `backdrop-brightness*`, inline
  `backdropFilter`, and the `supports-[backdrop-filter]:` modifiers).
- **62 decorative box/drop shadows** removed (`shadow-{sm..2xl,inner}`,
  `shadow-[...]`, `drop-shadow*`, inline `boxShadow`).
- **Legibility preserved**: glass surfaces that relied on blur for their frosted
  opacity were made solid — either by keeping the designed `supports-` *fallback*
  background, or by bumping translucent content surfaces to a solid token
  (mostly `/95`). Thin chips/badges with a border kept their low translucency
  (they read fine without blur).
- **Also removed in follow-up**: authored `ring-*` utilities and Tailwind
  focus-state styling (`focus:*`, `focus-visible:*`, `focus-within:*`) so those
  visual indicators do not reappear in app UI.
- **Preserved on purpose**: `text-shadow`, the `ShaderBackground` inset glow
  (the app background's lighting — static, painted once, cheap), and the
  `TutorialSpotlight` halo (a *functional* highlight, not decoration).

## Regression gate

`packages/ui/src/no-backdrop-blur-gate.test.ts` fails the build if any
`backdrop-filter` / `backdrop-blur` / `supports-[backdrop-filter]` creeps back,
so the battery win can't silently regress.

`packages/ui/src/no-focus-ring-gate.test.ts` fails if authored UI source adds
Tailwind `ring-*` utilities or focus-state visual classes back.

## Legibility verification (screenshots)

| File | Surface | Result |
| --- | --- | --- |
| `01-home.png` | home + composer + ambient background | glow intact, composer legible |
| `02-chat-open.png` | the main chat sheet (was the heaviest glass) | reads as a clean solid dark panel, text crisp |
| `04-settings.png` | settings (nav + cards) | flat, clean, legible |
| `05-database.png` | data tables (most opacity bumps) | solid cards defined by borders, fully legible |

ui typecheck clean; `no-backdrop-blur-gate` + `will-change-gate` green.

## Battery note

This removes both the per-frame re-rasterization on moving surfaces **and** the
continuous backdrop re-sampling on static glass — the latter is a constant GPU
cost whenever any blurred element is on screen, so the win applies at idle too,
and is largest on lower-end devices + WebKit (Capacitor) where backdrop-filter is
most expensive.
