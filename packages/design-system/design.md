# Design system

One accent on quiet neutrals. Color carries meaning; position and weight carry hierarchy.

- **Surfaces.** `background` is the page, `card` a raised panel, `popover` anything floating. `muted` and
  `secondary` are quiet fills, `accent` the hover and selection fill.
- **Text.** `foreground` by default, `muted-foreground` for what matters less. Every `x-foreground` is
  the text color on `x`, and each pair meets WCAG AA in both themes.
- **Edges.** `border` divides and may be faint. `input` is the edge of a control (a field, a checkbox, an
  outlined button): it stands at least 3:1 off `background` and `card` in both themes (WCAG 1.4.11).
- **Meaning.** `primary` is the one accent: the main action, links, the focus `ring`. `destructive`,
  `ok` and `warn` are states, never decoration.
- **Shape.** One `radius`; `rounded-sm`, `-md`, `-lg` and `-xl` derive from it. Three shadows, by elevation.
- **Motion.** `fast` for hover and press, `base` for most changes, `slow` for entering and leaving.
- **Dark.** Follows the system; a `.dark` or `.light` class on an ancestor overrides it.

Name a value by its token (`bg-primary`, `var(--primary)`), never by its value. Where a literal color
is unavoidable, such as a chart series or third-party markup, say why on the line above:
`// eslint-disable-next-line design-system/no-literal-colors -- chart series`.

## Changing it

`tokens.json` is the source; the CSS in `generated/` and the table below are built from it. Nothing reads
this prose into tokens. To change the design, describe it, and have the change written as a list in a file:

```json
[{ "path": "color.light.primary", "value": "oklch(0.45 0.2 277)", "reason": "deeper accent" }]
```

- `node ../../vibestack/design/cli.ts apply changes.json` refuses an unknown path, an invalid value or a
  pair below AA, and prints each token before and after.
- The same with `--write` updates `tokens.json`, the CSS and the table.
- `pnpm build` regenerates; `pnpm check` fails on invalid tokens, low contrast or a stale table.

<!-- tokens:start -->
| Color | Light | Dark |
| --- | --- | --- |
| `background` | oklch(0.976 0.001 286.4) | oklch(0.17 0.006 285.7) |
| `foreground` | oklch(0.21 0.006 285.9) | oklch(0.944 0.005 286.3) |
| `card` | oklch(1 0 0) | oklch(0.206 0.008 285.7) |
| `card-foreground` | oklch(0.21 0.006 285.9) | oklch(0.944 0.005 286.3) |
| `popover` | oklch(1 0 0) | oklch(0.206 0.008 285.7) |
| `popover-foreground` | oklch(0.21 0.006 285.9) | oklch(0.944 0.005 286.3) |
| `primary` | oklch(0.511 0.23 277) | oklch(0.682 0.173 282.3) |
| `primary-foreground` | oklch(1 0 0) | oklch(0.17 0.006 285.7) |
| `secondary` | oklch(0.959 0.004 286.3) | oklch(0.25 0.011 285.6) |
| `secondary-foreground` | oklch(0.21 0.006 285.9) | oklch(0.944 0.005 286.3) |
| `muted` | oklch(0.959 0.004 286.3) | oklch(0.25 0.011 285.6) |
| `muted-foreground` | oklch(0.532 0.017 285.8) | oklch(0.709 0.016 286) |
| `accent` | oklch(0.958 0.02 279.9) | oklch(0.276 0.072 281.7) |
| `accent-foreground` | oklch(0.21 0.006 285.9) | oklch(0.944 0.005 286.3) |
| `destructive` | oklch(0.577 0.215 27.3) | oklch(0.711 0.166 22.2) |
| `destructive-foreground` | oklch(1 0 0) | oklch(0.17 0.006 285.7) |
| `border` | oklch(0.92 0.004 286.3) | oklch(0.288 0.013 285.6) |
| `input` | oklch(0.64 0.012 286.1) | oklch(0.52 0.014 285.7) |
| `ring` | oklch(0.511 0.23 277) | oklch(0.682 0.173 282.3) |
| `ok` | oklch(0.527 0.137 150.1) | oklch(0.8 0.182 151.7) |
| `warn` | oklch(0.555 0.146 49) | oklch(0.837 0.164 84.4) |

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
