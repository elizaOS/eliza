# Design

A warm orange accent on quiet, warm neutrals. Color carries meaning; position and weight carry hierarchy.

- **Surfaces.** `background` is the page. `muted` and `secondary` are quiet fills, `accent` the hover fill.
- **Text.** `foreground` by default, `muted-foreground` for a to-do that is done. Every `x-foreground` is
  the text color on `x`, and each pair meets WCAG AA in both themes.
- **Meaning.** `primary` is the one accent: adding a to-do, a ticked box, the focus `ring`. `ok` is the
  tab's connection, filled when online and a ring when offline; `warn` counts refused edits. An edit the
  server has not answered yet shows its to-do at half strength.
- **Shape.** One `radius`; `rounded-sm`, `-md`, `-lg` and `-xl` derive from it.
- **Dark.** Follows the system; a `.dark` or `.light` class on an ancestor overrides it.

Name a value by its token (`bg-primary`, `var(--primary)`), never by its value: `pnpm lint` refuses a
palette class, an arbitrary color and a literal one.

## Changing it

`tokens.json` is the source; the CSS in `generated/` and the table below are built from it. Nothing reads
this prose into tokens. To change the design, describe it, and have the change written as a list in a file:

```json
[{ "path": "color.light.primary", "value": "oklch(0.5 0.19 38)", "reason": "deeper accent" }]
```

- `node ../../spec.ts tokens apply changes.json` refuses an unknown path, an invalid value or a pair
  below AA, and prints each token before and after; with `--write` it updates `tokens.json`, the CSS and the table.
- `pnpm tokens` regenerates; `node ../../spec.ts tokens check` fails on invalid tokens, low contrast or a stale table.

<!-- tokens:start -->
| Color | Light | Dark |
| --- | --- | --- |
| `background` | oklch(0.985 0.004 85) | oklch(0.2 0.006 70) |
| `foreground` | oklch(0.22 0.008 70) | oklch(0.95 0.008 85) |
| `card` | oklch(1 0 0) | oklch(0.235 0.008 70) |
| `card-foreground` | oklch(0.22 0.008 70) | oklch(0.95 0.008 85) |
| `popover` | oklch(1 0 0) | oklch(0.235 0.008 70) |
| `popover-foreground` | oklch(0.22 0.008 70) | oklch(0.95 0.008 85) |
| `primary` | oklch(0.553 0.195 38.4) | oklch(0.74 0.17 45) |
| `primary-foreground` | oklch(1 0 0) | oklch(0.2 0.006 70) |
| `secondary` | oklch(0.955 0.007 85) | oklch(0.28 0.01 70) |
| `secondary-foreground` | oklch(0.22 0.008 70) | oklch(0.95 0.008 85) |
| `muted` | oklch(0.955 0.007 85) | oklch(0.28 0.01 70) |
| `muted-foreground` | oklch(0.52 0.015 75) | oklch(0.72 0.015 80) |
| `accent` | oklch(0.95 0.03 55) | oklch(0.31 0.05 50) |
| `accent-foreground` | oklch(0.22 0.008 70) | oklch(0.95 0.008 85) |
| `destructive` | oklch(0.577 0.215 27.3) | oklch(0.711 0.166 22.2) |
| `destructive-foreground` | oklch(1 0 0) | oklch(0.2 0.006 70) |
| `border` | oklch(0.91 0.01 85) | oklch(0.32 0.012 70) |
| `input` | oklch(0.91 0.01 85) | oklch(0.32 0.012 70) |
| `ring` | oklch(0.553 0.195 38.4) | oklch(0.74 0.17 45) |
| `ok` | oklch(0.527 0.137 150.1) | oklch(0.8 0.182 151.7) |
| `warn` | oklch(0.53 0.11 85) | oklch(0.84 0.15 90) |

| Token | Value |
| --- | --- |
| `radius` | 0.5rem |
| `font.sans` | ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif |
| `font.mono` | ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace |
| `shadow.sm` | 0 1px 2px oklch(0 0 0 / 0.08) |
| `shadow.md` | 0 4px 12px oklch(0 0 0 / 0.12) |
| `shadow.lg` | 0 12px 32px oklch(0 0 0 / 0.18) |
| `breakpoint.sm` | 40rem |
| `breakpoint.md` | 48rem |
| `breakpoint.lg` | 64rem |
| `breakpoint.xl` | 80rem |
| `duration.fast` | 100ms |
| `duration.base` | 150ms |
| `duration.slow` | 300ms |
| `ease.standard` | cubic-bezier(0.4, 0, 0.2, 1) |
<!-- tokens:end -->
