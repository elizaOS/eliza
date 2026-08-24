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
count. The gate rejects unknown primitives, missing exports, moved or removed
compositions, count drift, and attempts to reuse an adapter's local recipe from
another caller. Exceptions remain reserved for renderer, native, or external
system boundaries; they do not waive the Button reuse rule.

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

Data tables use the canonical table parts. Rows stay flat and use the
primitive-owned one-pixel semantic bottom divider. Do not wrap ordinary rows in
individual cards or add caller-owned row borders. Header, hover, selected, and
density presentation stay in the table primitives.

Repeated multi-atom structures belong in a shared pattern only when they own
the same behavior and state lifecycle. Dependency similarity alone is not a
pattern. The molecular inventory records a final disposition and rationale for
every detected cluster; unresolved candidates and duplicate implementations
must not pass the completion gate. The accepted final dispositions are
`distinct-domain-compositions` and `shared-lifecycle-owner`; adding another
requires a gate and policy change in the same review. Run
`audit:molecular-inventory` to update the committed report after source or
decision changes. Package lint checks that the report is current.

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
