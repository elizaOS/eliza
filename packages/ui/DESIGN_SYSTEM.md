# Canonical design system

`@elizaos/ui` owns the shared visual and interaction contracts for maintained
elizaOS frontends. The system has three layers.

1. Semantic tokens in `src/styles` own color, typography, spacing, radius,
   elevation, motion, focus, dividers, and minimum touch targets.
2. `src/components/ui` is the only atomic implementation layer. It owns native
   semantics, accessibility, interaction states, and base presentation.
3. Composites and domain adapters may arrange canonical atoms and add product
   behavior. They must not recreate the atom underneath them.

## Using canonical atoms

External consumers import stable exports such as `@elizaos/ui/button` or the
curated `@elizaos/ui` root. Code inside this package imports the owning module
directly. Consumers must not import Radix primitives, deep
`@elizaos/ui/components/ui/*` paths, or atomic variant helpers to restyle a
different element.

Canonical atoms expose typed variants for repeated visual states. A caller may
use `className` for its own placement and layout, including margins, width
constraints, flex placement, shrinking, and ordering. Color, background,
border, radius, typography, control height, padding, focus, hover, disabled,
selected, invalid, loading, and destructive presentation belong to the atom's
typed interface.

Raw semantic utilities can still reproduce a canonical recipe without using
its owner. The compliance gate therefore normalizes class order and rejects the
opaque padded surface recipe (`bg-card`, `rounded-sm`, and `p-4`) on raw hosts;
use `Card variant="flatPadded"`. The corresponding outlined recipe is owned by
`Card variant="outlinedPadded"` and is independently order-normalized and
ratcheted to zero. Analytics-style report surfaces use
`Card variant="reportPanel"`; repainting `Card` with that background and border
pair is also rejected even when it arrives through an internal barrel. `Card`
also owns repeated vertical content spacing through
the typed `stack` axis and repeated column geometry through `flow`, so callers
do not repaint or redensify the surface through `className`.

Inset rows and compact settings panels use `insetPadded` or `insetCompact`.
Their shared `bg-surface`/border/radius recipe is normalized independently of
the density utilities, and repeated row alignment comes from the `flow` axis.

The same ownership rule applies to computed classes and React `style` objects.
Conditional expressions, templates, named class constants, CSS-module lookups,
and styling helper calls cannot conceal atom paint. Canonical controls reject
inline background, color, border, radius, shadow, outline, padding, height,
gap, fill, and stroke properties. Put dynamic placement on a non-control
wrapper. Use a reviewed exception when runtime domain paint cannot be expressed
as a finite typed presentation.

`Button unstyled` is migration debt, not a supported customization surface.
The compliance inventory counts every maintained use so the escape hatch can
only shrink. Replace a repeated presentation with a typed canonical variant;
do not rename the bypass or reproduce it in an adapter.

A local adapter is valid when it composes a canonical atom and owns meaningful
domain behavior. An adapter that only renames props or duplicates styling is a
violation. Add a canonical variant only after at least two maintained callers
demonstrate the same need. The compliance gate derives every `Button` variant,
size, shape, and alignment value from the canonical `buttonVariants` config and
counts its maintained `Button` and `buttonVariants(...)` call sites. A value
with fewer than two call sites fails. Stateful product presentation belongs in
an exported adapter that renders the canonical atom and is registered in
`scripts/design-system-adapters.json`. Each registry entry fixes the owning
file, exported symbol, canonical primitive, owner, rationale, and composition
count, and token role. The gate rejects unknown primitives, missing exports, moved or removed
compositions, count drift, and attempts to reuse an adapter's local recipe from
another caller. Exceptions remain reserved for renderer, native, or external
system boundaries; they do not waive the Button reuse rule.

`scripts/component-inventory-decisions.json` classifies the current atomic
inventory. `scripts/atomic-consolidation-ledger.json` separately records every
component accepted as consolidation debt and its resolution. An unresolved
entry remains an `atomic-duplicate` finding after deletion, rename, or decision
relabeling. A deleted resolution stays valid only while the old component and
any retired module remain absent and the canonical owner remains present. An
adapter resolution must keep composing that exact canonical owner. The
ordinary baseline may only hold or reduce the count. Completion uses the tight
zero baseline.

## Token-role contracts

Canonical recipes are fail-closed. Every `cva` helper in `components/ui`, each
of its axes, and every registered adapter has an exact role in the compliance
gate. Adding a helper, axis, or adapter without a known role fails. The roles
admit semantic token families, not individual raw colors:

| Role | Foreground | Surface | Border/divider | Status and action | Radius | Spacing/density | Elevation | State |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `action` | content, muted, on-action, inverse, contextual | neutral, inverse, transparent | structural, inverse, transparent | action and status families | control, container, pill | control scale | none or low | hover, focus, active, disabled, selected, invalid, pointer, responsive, group |
| `field` | content, muted, inverse | neutral, inverse, transparent | structural, inverse, transparent | status feedback only | control, container, pill | control scale | none | hover, focus, disabled, invalid, placeholder, file, pointer, responsive |
| `surface` | content, muted, inverse | neutral, inverse, transparent | structural, inverse, transparent | status feedback only | control, container, pill | container scale | semantic scale | hover, focus, active, disabled, selected, invalid, responsive, group |
| `status` | content, muted, on-action | neutral, transparent | structural, transparent | action and status families | control, container, pill | compact or container scale | none or low | hover, focus, active, disabled, selected, responsive, group |
| `content` | content, muted, action, status, contextual | transparent only | structural or transparent | foreground only | none | compact scale | none | hover, responsive, group |
| `layout` | none | none | none | none | none | layout scale | none | responsive or group-derived layout |

Semantic namespaces are `txt`/`foreground` content, `bg`/`card`/`surface`
neutral surfaces, `border`/`input`/`ring` structure, `accent`/`primary` action,
named status tokens, contextual `header`/`sidebar` tokens, and the stable
`inverse` pair for light-on-dark or light-on-accent controls. Palette utilities,
arbitrary color values, arbitrary control density, arbitrary elevation, and
`transition-all` are invalid in canonical and registered-adapter recipes.

The gate also normalizes semantic aliases when comparing variants inside an
axis. Exact duplicates and recipes that differ only by equivalent aliases fail;
one recipe must own that presentation. Layout differences do not make two
paint recipes divergent, and distinct status tones remain distinct recipes.

Skeleton geometry is caller-owned because it previews the dimensions and shape
of caller content. Skeleton paint, animation, and effects remain owned by the
canonical primitive.

Tabs container layout is caller-owned because the root participates in its
page's flex and overflow structure. Tab paint and interaction presentation
remain owned by the canonical primitive.

Native inputs are typed adapters. File inputs use `nativeFileHidden` or
`nativeFileDisplayNone`, range inputs use `nativeRange`, and color inputs use
`nativeColor`. A native presentation cannot be paired with another input type.
Stories and composition tests must include the visible trigger, label, value,
focus, disabled, keyboard, ref, and change behavior that applies to the adapter.

## Shared patterns

Use the narrowest shared lifecycle owner that fits:

- `SettingsRow` and the typed settings-control rows own settings label,
  description, control placement, disabled state, and row geometry. Domain
  adapters may add agent registration or value mapping, but must compose these
  rows instead of painting another settings shell.
- `ContentState` owns empty and loading presentation across panel, inset,
  surface, and workspace placements. Page-specific wrappers supply copy and
  behavior rather than rebuilding the state geometry.
- `PagePanel.ContentRail` owns centered content widths and the shared 16px to
  24px responsive horizontal inset for routed views. Headers, scrolling,
  vertical safe areas, and chat-composer clearance stay with their narrower
  route or workspace lifecycle owner.
- `ActionListRow` owns a single row-level action with native button, link, or
  static semantics and typed leading, copy, metadata, and trailing slots. It is
  not suitable for rows with multiple independent controls or domain progress.
- `AuthResultShell` owns the full-page background, centered card, and content
  geometry for public authentication outcomes. Result pages supply only their
  state-specific icon, copy, and actions.
- `ConnectionCapabilityTile` owns the icon, title, and description hierarchy
  used by connector setup grids. Provider screens supply translated content
  and provider-specific icon paint.
- `StatusBadge` owns status paint. Domain adapters map typed domain states to a
  canonical tone and label; they do not reproduce badge classes.

Data tables use the canonical table parts. Rows stay flat and use the
primitive-owned one-pixel semantic bottom divider. Do not wrap ordinary rows in
individual cards or add caller-owned row borders. Header, hover, selected, and
density presentation stay in the table primitives.

Repeated multi-atom structures belong in a shared pattern only when they own
the same behavior and state lifecycle. Dependency similarity alone is not a
pattern.

The molecular review follows this enforced sequence:

1. Discovery groups components by role and atomic dependencies. Each decision
   records the exact `file:symbol` member IDs and a semantic fingerprint of
   every member's atomic dependencies and rendered tags. Membership or
   rendered-structure drift invalidates the decision even when the broad
   dependency signature stays the same.
2. Review records `distinct-domain-compositions` or
   `shared-lifecycle-owner` only after ownership is settled. `unresolved` and
   `canonicalize` are explicit working states. Both fail the completion gate.
   A `canonicalize` decision also names the canonical contract that will own
   the result.
3. Before broad caller migration, a new entry in
   `scripts/molecule-contracts.json` must name at least two maintained
   consumers from different files. It must also name a Storybook story and a
   behavioral test that each render the contracted owner through its resolved
   import, including aliases and barrels. The audit verifies the owner,
   required composition signals, consumers, story, and test.
4. Migrate the remaining callers, remove the non-final cluster decision, and
   regenerate the report. `audit:molecular-inventory --check` derives JSON and
   Markdown from one in-memory report and rejects either artifact when stale.

Rendered stories and the app visual audit own geometry proof. Source-text class
assertions are not a substitute for rendered behavior.

## Design contract graph

`audit:design-contract-graph` derives a typed ownership graph from the live
semantic-token stylesheet, every maintained React component symbol, the
canonical atom inventory, molecule contracts, and higher-order declarations.
Source discovery is authoritative: aliases, barrels, and local wrappers are
resolved through TypeScript symbols, atom dependencies are closed transitively,
and reuse across independent source domains infers molecule ownership even when
no registry entry names the component. Registries add semantic stability
contracts to discovered owners; omission from a registry cannot hide an owner.

The graph validates token aliases, canonical import identity, downward
dependencies, real exported owners, raw capability ownership, and exact
migration debt. Debt is keyed by a semantic fingerprint and match count, so
removing one finding cannot make room for a different finding under the same
aggregate count. Tight CI also rejects stale and expired debt.

The graph distinguishes canonical implementations from route instances.
Organism and page-shell declarations may name component owners and supported
layout kinds, but route IDs and resolved layout policy remain in the existing
route declarations and `SurfaceManifest`. `PageLayoutManifest` keeps content,
workspace, and immersive topology separate from header framing and renderer
isolation. This prevents the design graph from becoming another route registry.

Repository-wide raw painted and interactive hosts remain migration inventory.
Inside a source-inferred molecule, however, a raw host that claims surface,
border, radius, elevation, or interaction capability is an enforced finding.
New claims fail immediately. Existing migration debt is exact and expiring;
tight mode also fails after a cleanup until the ledger is reduced, preventing
removed debt from becoming allowance for unrelated drift. Completion requires
that molecular capability debt reach zero.

## Story and accessibility proof

The story-coverage ratchet checks both the number of covered components and the
coverage ratio against `scripts/stories-coverage-baseline.json`. It also rejects
any component newly added to the missing-story set, so swapping coverage between
two components cannot hide a regression. Run `node scripts/stories-coverage.mjs
--check` for the enforced check or `audit:story-coverage` for a report.

Story Gate renders the built Storybook catalog in Chromium. Console errors that
remain after the static-harness noise filters and serious or critical axe
violations fail directly; neither uses a per-story allowlist or baseline. A
component that requires live app context may be classified `needs-runtime`,
which moves its coverage to the full app audit rather than turning missing
runtime state into a false component failure.

## Compliance and exceptions

Run `bun run --cwd packages/ui audit:design-system` to scan maintained package
and plugin React sources. The committed baseline blocks every category from
growing. A cleanup must lower the affected count with
`audit:design-system:update-baseline` in the same change; the command refuses
to raise any count. CI uses a tight-baseline mode, so a stale allowance also
fails after cleanup instead of silently preserving room for regressions.

Product source and Storybook examples are governed. Test files, test fixtures,
generated output, and templates are excluded because they imitate host and
failure boundaries rather than ship as maintained product UI.

Legitimate renderer, native, or external-system cases live in
`scripts/design-system-exceptions.json`. Each exception names one rule, file,
symbol, owner, reason, review date, expected match count, and exact source lines
when the exception covers a specific occurrence. Inline suppressions are not
supported. The gate fails when an exception expires, moves, changes count, or
no longer matches a finding.

Zero violations means every ratcheted count is zero and every remaining
non-canonical implementation is a current, centrally reviewed exception.
