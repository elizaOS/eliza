# `@elizaos/ui/spatial` — modality-agnostic view authoring

elizaOS ships views on the **GUI** (the dashboard). Views are still authored
modality-agnostically: the `SpatialModality` contract keeps `"xr"` and `"tui"`
as valid values, the terminal registry/renderer (`spatial/tui`) remains as
authoring + test infrastructure (and is consumed by `@elizaos/tui`), and the
layout IR (`ir.ts`) is the cross-surface contract. The shipped XR renderer and
the XR/TUI review harnesses were removed (#15269); reintroducing a non-GUI
surface should happen deliberately against this contract.

You author a view **once** with a small primitive vocabulary; the same React
tree renders to the GUI DOM and (in tests/tooling) to terminal lines, because
both consume one **layout IR** (`ir.ts`).

```
            ┌─────────────────────────┐
            │   <AgentProfileView/>   │   ← authored once (React + primitives)
            └────────────┬────────────┘
              GUI / XR    │    TUI
        ┌────────────────┐│┌──────────────────────┐
        │ primitives →   │││ evaluate → SpatialNode│
        │ DOM (dom.tsx)  │││ → engine → terminal    │
        └────────────────┘│└──────────────────────┘
                          ▼
                 same SpatialNode IR
```

## Quick start

```tsx
import { Card, HStack, Text, Button, useSpatialState } from "@elizaos/ui/spatial";

export function Counter({ start = 0 }) {
  const [n, setN] = useSpatialState(start); // works on every surface
  return (
    <Card title="Counter" gap={1}>
      <Text style="heading">{`Count: ${n}`}</Text>
      <HStack gap={1}>
        <Button onPress={() => setN((v) => v + 1)}>+1</Button>
        <Button variant="outline" onPress={() => setN(0)}>Reset</Button>
      </HStack>
    </Card>
  );
}
```

Render it:

```tsx
// GUI
import { SpatialSurface } from "@elizaos/ui/spatial";
<SpatialSurface modality="gui"><Counter /></SpatialSurface>

// TUI (Node-only subpath; authoring/test infrastructure)
import { renderViewToLines } from "@elizaos/ui/spatial/tui";
const lines = renderViewToLines(<Counter />, 40); // string[] of width 40
```

The reference view is [`example.tsx`](./example.tsx); the proof that one source
renders on every surface of the contract is
[`__tests__/parity.test.tsx`](./__tests__/parity.test.tsx).

## The vocabulary

| Primitive | IR node | Purpose |
| --- | --- | --- |
| `Stack` / `HStack` / `VStack` | `box` | flex container (`direction`, `gap`, `padding`, `align`, `justify`, `wrap`, `grow`) |
| `Card` | `box` | bordered, padded, optionally titled surface |
| `List` | `box` | vertical list (a column with a default gap) |
| `Text` | `text` | typed text (`style`, `tone`, `bold`, `dim`, `align`, `wrap`) |
| `Button` | `button` | action (`tone`, `variant`, `disabled`, `onPress`) |
| `Field` | `field` | labelled input (`text`/`number`/`password`/`textarea`/`select`) |
| `Divider` | `divider` | rule, optionally captioned |
| `Spacer` | `spacer` | fixed (`size`) or flexible (`grow`) space |
| `Image` | `image` | image (real `<img>` on DOM, alt placeholder in TUI) |

Layout props mean the same thing in every modality. The renderers only differ in
the unit a cell maps to: a CSS rem on GUI/XR, a terminal column in the TUI.

## Cross-modal state

Use the `useSpatial*` hooks for any state that must work on every surface:

- `useSpatialState(initial)` — on a DOM surface delegates to React's `useState`;
  during TUI evaluation it reads/writes the host's persistent store keyed by
  component path + hook order, and re-snapshots the frame on change.
- `useSpatialMemo(factory, deps)`, `useSpatialRef(initial)` — same dual behaviour.

**Authoring constraint:** in a view you want to run in the terminal, use the
`useSpatial*` hooks rather than React's `useState`/`useEffect`/`useContext` — the
React hooks only run on the DOM surface. Purely presentational components (props
in, primitives out) need no hooks and work everywhere with no constraints.

The TUI evaluator is a **snapshot** renderer: it produces one frame and does not
run effects (which is exactly right for a terminal frame). Interactivity comes
from the host re-snapshotting after a `useSpatialState` setter fires — see
`createSpatialTuiComponent`.

## Wiring into the existing view system

The framework is additive — it does not change how views are *declared*
(`ViewDeclaration` in `@elizaos/core`) or *served* (`/api/views`). It changes how
a view is *authored* and *rendered*:

- **GUI** — a unified view's bundle export is an ordinary React component; the
  existing `DynamicViewLoader` mounts it. Wrap the root in `<SpatialSurface
  modality="gui">`. Agent-surface attributes (`data-agent-id`, `data-agent-role`)
  are emitted automatically from each primitive's `agent` prop, so the existing
  view-interact capabilities (`list-elements`, `agent-click`, …) work unchanged.
- **XR (contract only)** — `modality="xr"` remains a valid `SpatialSurface`
  value (a view host that sets `window.__elizaXRContext` gets the same DOM,
  spatially scaled), but no XR renderer ships from this package.
- **TUI** — the agent terminal mounts the view with
  `createSpatialTuiComponent(() => <View/>, { onChange: () => tui.requestRender() })`,
  which yields a `@elizaos/tui` `Component`. This replaces the hand-written
  `*TuiView` and is the first time `viewType: "tui"` declarations actually render.

## Migration: collapsing three views into one

Before — three components, two of them duplicating layout, one (TUI) unbuilt:

```tsx
export function PhonePluginView() { return <div className="…">…</div>; }   // gui + xr
export function PhoneTuiView() { /* hand-rolled terminal strings, never rendered */ }
```

After — one component, authored with the primitives:

```tsx
import { VStack, Text, List, Button } from "@elizaos/ui/spatial";
export function PhoneView({ calls }: { calls: Call[] }) {
  return (
    <VStack gap={1} padding={1}>
      <Text style="heading">Recent calls</Text>
      <List>{calls.map((c) => <Text key={c.id}>{c.name}</Text>)}</List>
      <Button agent="dial">Dial</Button>
    </VStack>
  );
}
```

Then collapse the three `plugin.views` entries to one bundle export reused by all
modalities (the `viewType` declarations still distinguish surface behaviour like
`xrOptions`, but they point at the same export).

## Limitations (v1)

- TUI rendering is snapshot-based: no React effects in the terminal path; drive
  interactivity through `useSpatialState` + host re-snapshot.
- Raw DOM elements (`<div>`, `<span>`) have no terminal layout — a view that must
  run in the terminal should be built from the primitives. The evaluator degrades
  an unknown host element to its children so text still flows.
- Percentage lengths and vertical `justify`/`grow` in the TUI engine apply only
  when a fixed height is supplied; content-height columns lay out top-to-bottom.
- **Avoid East-Asian-ambiguous glyphs in terminal-bound text.** A glyph like `✓`
  (U+2713) measures as width 2 in the Unicode width table but renders 1 cell wide
  in many fonts/terminals, so a line that's correct by measurement misaligns
  visually. Prefer unambiguous width-1 markers (`●`/`○`, `■`/`□`, `+`, `x`). Box
  drawing, `•`, `›`, `…`, `▾` are all width-1 and safe. A fixed cell `width` also
  doesn't translate (0.25rem in DOM vs. one column in the terminal) — use
  `width="100%"` / `grow` for "fill", not a fixed cell count.

## Verifying — the screen gallery

`gallery.tsx` is a corpus of representative screen archetypes (profile, list,
settings, dashboard, chat, empty, error, connect, wallet, table, confirm,
progress), each authored once. `__tests__/gallery.test.tsx` asserts every screen
renders to IR + TUI (width contract at 48/32/24) + DOM.

## Verifying — TUI framing linter

`tui/framing.ts` (`analyzeFraming`) checks a rendered block for *structural*
correctness, not just width: uniform line width, closed + column-aligned box
borders (including titled `╭─ Title ─╮` frames), **no nested boxes** (a single
outer frame per view is the house style; sections use labelled dividers), and
**no truncated buttons** (`[ label` with the closing ` ]` cut off). It gates the
gallery (`__tests__/framing.test.ts`) at realistic widths (56/40). Export every
gallery render for a human read with `tui/review-export.mjs` →
`/tmp/tui-*-review.txt`.

## Verifying — TUI keyboard interaction

Terminal views are interactive: `createSpatialTuiComponent` builds a focus model
over the view's activatable buttons. **Tab / ↓ / Ctrl-N** and **Shift-Tab / ↑ /
Ctrl-P** move focus (the focused control renders inverse + underlined); **Enter /
Space** activate it (running its `onPress` → `useSpatialState` update →
re-render) and fire `onActivate(agentId)`. The agent terminal's detail mode
forwards input straight through, so every `viewType:"tui"` view is keyboard
drivable. See `__tests__/tui-interaction.test.tsx`.
