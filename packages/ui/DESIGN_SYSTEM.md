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

`Button unstyled` is migration debt, not a supported customization surface.
The compliance inventory counts every maintained use so the escape hatch can
only shrink. Replace a repeated presentation with a typed canonical variant;
do not rename the bypass or reproduce it in an adapter.

A local adapter is valid when it composes a canonical atom and owns meaningful
domain behavior. An adapter that only renames props or duplicates styling is a
violation. Add a canonical variant only after at least two maintained callers
demonstrate the same need.

Skeleton geometry is caller-owned because it previews the dimensions and shape
of caller content. Skeleton paint, animation, and effects remain owned by the
canonical primitive.

## Compliance and exceptions

Run `bun run --cwd packages/ui audit:design-system` to scan maintained package
and plugin React sources. The committed baseline blocks every category from
growing. A cleanup must lower the affected count with
`audit:design-system:update-baseline` in the same change; the command refuses
to raise any count.

Product source and Storybook examples are governed. Test files, test fixtures,
generated output, and templates are excluded because they imitate host and
failure boundaries rather than ship as maintained product UI.

Legitimate renderer, native, or external-system cases live in
`scripts/design-system-exceptions.json`. Each exception names one rule, file,
symbol, owner, reason, and review date. Inline suppressions are not supported.
The gate fails when an exception expires or no longer matches a finding.

Zero violations means every ratcheted count is zero and every remaining
non-canonical implementation is a current, centrally reviewed exception.
