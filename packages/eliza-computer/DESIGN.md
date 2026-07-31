# eliza.army design system

## Direction

The page is a maintainer's merge desk after midnight: black equipment labels,
white working notes, and one orange current running through the workflow. It
inherits the existing elizaOS dark identity while using a public ledger rather
than app chrome as its spatial model.

## Color

Use the established elizaOS palette, expressed as OKLCH tokens with hex
fallbacks.

| Role | OKLCH | Fallback | Use |
| --- | --- | --- | --- |
| Canvas | `oklch(0 0 0)` | `#000000` | Page background |
| Surface | `oklch(0.16 0 0)` | `#101010` | Code and table surfaces |
| Ink | `oklch(1 0 0)` | `#ffffff` | Primary text |
| Muted ink | `oklch(0.78 0 0)` | `#b9b9b9` | Secondary copy |
| Rule | `oklch(1 0 0 / 0.16)` | `rgba(255,255,255,.16)` | Dividers |
| Signal | `oklch(0.70 0.20 43)` | `#ff5800` | Primary action and live state |
| Signal hover | `oklch(0.64 0.19 43)` | `#e34d00` | Resting-orange hover |
| Verified | `oklch(0.72 0.14 157)` | `#58c98f` | Passed/merged status |
| Warning | `oklch(0.78 0.16 84)` | `#e9b949` | Attention status |
| Failure | `oklch(0.67 0.20 24)` | `#ef6262` | Error status |

Orange carries roughly 10–15% of the surface. It indicates the active current;
it is never a decorative gradient and never turns black on hover.

## Typography

Use Poppins, the committed elizaOS brand family, in weights 400, 500, 600, 700,
and 800. Use the platform monospace stack only for commands, model identifiers,
timestamps, and repository coordinates. Body type is `1rem` or larger with a
maximum measure of `68ch`. Display text uses a bounded fluid scale and never
exceeds `5.5rem` or `-0.035em` tracking.

## Layout

- Mobile-first, one continuous document with a `min(100% - 32px, 1200px)`
  content rail.
- The hero uses an asymmetric two-column split only when the install terminal
  has room; it becomes a single decisive flow on narrow screens.
- Major sections are separated by full-width rules and varied vertical rhythm,
  not repeated containers.
- The leaderboard is a semantic table on wide screens and a labelled row list
  on narrow screens. Rank, contributor, result breakdown, model disclosure, and
  score remain visible in both forms.
- Commands and methodology use bounded surfaces with 3–8px radii. Cards never
  exceed 12px and are never nested.

## Signature motif

A one-pixel orange execution trace connects the install action, workflow, and
ledger. Small square status lamps mark live, verified, and attention states.
The motif communicates progress; it never becomes a decorative grid or stripe
background.

## Components

- **Reward callout:** exact monthly pool, public payout-address setup, and no
  implied relationship between leaderboard points and payment.
- **Install console:** a real selectable command, explicit copy feedback,
  agent-specific tabs, raw skill link, and `.skill` download.
- **Work queue:** live open issue and pull-request links with scope, labels,
  recency, and claim state. Loading, empty, stale, and error are distinct.
- **Contribution ledger:** transparent score rows with expandable breakdowns
  and declared model identifiers.
- **Methodology ledger:** exact weights, caps, time window, bot exclusions, and
  refresh timestamp.
- **Status notice:** icon/shape plus text; never color alone.

## Motion

Use one brief first-load trace (500–700ms) and 100–220ms feedback transitions
for copy, tabs, and row disclosure. Do not fade every section on scroll.
`prefers-reduced-motion: reduce` removes trace travel and nonessential
transforms while preserving every state change.

## Responsive and input behavior

- Compose at 320px, 768px, 1024px, and 1440px without horizontal page scroll.
- Every primary control has a 44×44px hit area and a keyboard-visible focus
  ring.
- Hover enhances but never reveals required information.
- Long GitHub handles, issue titles, labels, model IDs, and translated copy wrap
  without overlap.
- Respect safe-area insets and print the methodology/leaderboard cleanly.
