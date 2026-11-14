---
name: design
description: "Design or review anything a person looks at, built from a spec in this repository: a page, screen, component, chart, dashboard, report or CLI output. Use before writing UI code, when choosing a layout or visual direction, and when reviewing UI for clutter, wordiness or missing spec content."
---

# Design from the spec

## Before you draw

1. **Inventory.** For each story in `spec/**/*.md`, write down what the user
   must see or do, and the rule behind it. That list is the whole content:
   everything on it ships; no page, section, setting or sample content off it does.
2. **Cut.** For each item ask: does the user need to see this, here, now? What
   do they need that is not on the list? Remove what fails; add what is missing.
3. **Three directions.** Sketch three different approaches (layout, hierarchy,
   brand treatment), a sentence or a rough SVG each. Pick the one that shows the
   inventory with the fewest elements and the clearest identity.

## Rules

| Instead of | Use |
|---|---|
| Text a visual can carry | A chart, icon, color, shape or SVG |
| A number inside a sentence | The number alone, large, or a bar or meter |
| A status word | Color, shape or icon, with the word as its accessible name |
| A paragraph explaining a flow | A diagram |
| A label repeating what the element shows | Nothing |
| A chip, pill, badge, eyebrow or divider | Position, weight or color, or nothing |
| Filler in empty space | Whitespace |

- **Few words.** No explanations, disclaimers, helper text, sub-headers,
  taglines or detail lines under titles. One heading per view at most.
- **Accessible.** Every visual keeps its meaning in `aria-label` or `alt`. Text
  contrast meets WCAG AA.
- **Untested.** Words, layout and styles get no tests. A journey test through
  the UI asserts what the user can do and what the state became, not what the
  page says (AGENTS.md, "Tests").
- **One system.** One type pairing, a small palette with one accent and one
  spacing scale, as the project's design tokens. Extend an existing component
  before adding one.
- **Tokens.** Every interface is built on the stack (AGENTS.md, "The
  stack"). Name a color, size or radius by its token, never by its value; a
  new value is a new token, added once ("Components, stories and tokens").

## Review: two or three passes

Reread the rules above before each pass, then ask:

- What could go with no story losing anything? Remove it.
- What text could be a visual? What visual could be smaller?
- What from the inventory is missing?
- Does the eye land first on what matters most?

Stop when a pass changes nothing. Report the chosen direction in one line, and
anything cut that the user might expect to see.

## Components, stories and tokens

A component is ordinary source the project owns: one `.tsx` file in
`src/components/`, a named export, an exported `<Name>Props` type, and a
JSDoc sentence on the component and on each prop that needs one. In this
repository they are `@repo/ui`; a standalone project keeps its own.

| | Source, kept in Git | Generated, never committed | Command, in the project |
|---|---|---|---|
| Tokens | `tokens.json`, and `design.md` describing them | `generated/tokens.css`, `generated/theme.css` (the Tailwind v4 entry) | `spec tokens build`, `check` |
| Stories | the component, and `<Name>.meta.tsx` where its types are not enough | `generated/stories/`: Storybook stories, `catalog.json`, and a mount test and a browser test (accessibility) of every story; a disabled or loading story is played to check that it refuses clicks and keys | `spec stories gen [--watch] [--check]` |

`spec` is the tool's command: `pnpm exec spec` in a project that installed
it, `node ../../spec.ts` in an example. In `@repo/ui`: `pnpm gen` (the stories),
`pnpm storybook`, `pnpm test`, `pnpm test:browser`; in
`@repo/design-system`: `pnpm build`, `pnpm check`.

- **Never write a story for what the generator can derive.** It reads each
  prop's type, default and JSDoc and writes a Default story, one per option
  of a union or boolean prop, and Disabled, Loading, Error and Empty where
  such a prop exists, twelve at most. A hand-written `<Name>.stories.tsx`
  beside the component is kept, and wins over a generated story of the same
  name.
- **`<Name>.meta.tsx`** exports `meta: ComponentMeta<Props>` (from
  `vibestack/stories`): `args` every story starts from, named `examples` and
  `states`, `bounds` of a numeric prop, a `schema` to sample, a `decorator`,
  and `play` interactions, which is where a component's behaviour is tested:
  no test compares screenshots. Stories, tests and Studio read the same
  object; a field it does not have is reported. A required prop the generator cannot give a
  value is reported, with the field to add; it never invents data.
- **A component that shows a model** says so: `@model spec/index.md` in its
  JSDoc links it to that spec's state and events, and `@design design.md#…`
  to its design document. Studio's Components view follows both ways.
- **A file named after one of its exports** (`Dialog.tsx`) gives stories to
  that component; its other exports are its parts.
- **Colors, radii, shadows and fonts are tokens.** Use the utilities named
  after them (`bg-primary`, `text-muted-foreground`, `rounded-md`); the lint
  rules of `vibestack/design/eslint.ts` refuse a palette class, an arbitrary
  color and a literal color in a style. Merge classes with `cn()`; use CVA
  only where a component has real variants.
- **A design change is a token change.** Describe it in `design.md`, write
  it as `[{ "path": "color.light.primary", "value": "oklch(…)", "reason": "…" }]`,
  and run `spec tokens apply changes.json`: it refuses an
  unknown path, an invalid value and a contrast below WCAG AA, and prints
  the diff; `--write` applies it and rebuilds the CSS. Prose is never read
  as tokens.

To change a component: find it in `generated/stories/catalog.json` or in
Studio's Components view, read its props and model there, edit the source,
run `pnpm gen` (or leave `pnpm storybook` running), look at it, then
`pnpm test` and `pnpm lint`.
