# Color & Hover System

The brand uses **black, white, and one accent orange** (`#FF5800`, exposed as
`var(--brand-orange)` and Tailwind's `orange-*` family). No blue.

## Forbidden classes

Anywhere in `src/`:

- `bg-blue-*`, `text-blue-*`, `border-blue-*`, `ring-blue-*`
- `hover:bg-blue-*`, `hover:text-blue-*`, `hover:border-blue-*`
- `from-blue-*`, `to-blue-*`, `via-blue-*`

If you want to convey an accent state, use the orange family. If you only
needed a "tint different from default", use neutral white/black with opacity
(`bg-white/10`, `text-white/70`, `border-white/15`, etc.).

Semantic colors that are NOT in scope of this rule and remain allowed:

- `red-*` for destructive / error states
- `green-*` for success / healthy states
- `yellow-*` / `amber-*` for warnings

## Hover rules

1. **Orange resting → orange hover only.** An element with a `bg-orange-*`
   or `text-orange-*` resting state must hover to a darker / lighter shade
   of orange (`hover:bg-orange-600`, `hover:text-orange-300`). It must
   never hover to black, white, or a neutral fill — that produces the
   "orange flashes to black" effect the brand explicitly rejects.

2. **Neutral resting → neutral hover.** Rows, ghost buttons, table cells,
   list items, and other non-CTA UI should use neutral hovers:
   `hover:bg-white/5`, `hover:bg-black/5`, `hover:border-white/20`.
   Avoid hovering into a saturated orange fill from a neutral resting
   state unless the element is an obvious primary call-to-action.

3. **Semantic-action ghost buttons may accent on hover.** Icon-only action
   buttons that sit in a row of related actions (e.g. play / suspend /
   delete) may hover to their semantic color
   (`hover:text-green-400`, `hover:text-orange-400`,
   `hover:text-red-400`) because the color carries meaning. Keep the
   resting state neutral (`text-white/30`).

4. **Primary CTA contrast inversion is fine.** Big black-on-white or
   white-on-black buttons (`bg-black hover:bg-white hover:text-black`,
   `bg-white hover:bg-black hover:text-white`) remain the canonical
   primary call-to-action pattern.

## Status colors

For badge / pill / status indicators, prefer:

- success → `green-*`
- error / failed → `red-*`
- warning / attention → `orange-*` or `amber-*`
- in-progress / informational → neutral `white/10` + a small icon, not blue

If a status genuinely needs a third accent beyond orange, use a neutral
chip and let the icon carry the meaning.
