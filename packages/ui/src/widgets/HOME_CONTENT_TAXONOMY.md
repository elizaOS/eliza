# Home content taxonomy (#9959)

The home surface is a *prioritized, self-pruning* dashboard, not a static grid.
Every `slot:"home"` widget is ranked by `home-priority.ts` and capped at
`HOME_RENDER_CAP` in `WidgetHost.tsx`; each widget self-hides (renders `null`)
when it has nothing worth showing. This file is the single source of truth for
*what kind of content* belongs on the home and how each tier behaves — previously
this lived implicitly in the `slot:"home"` declarations in `registry.ts`.

## Tiers

### Tier 1 — Ambient base (always present)
Clock + weather (`DefaultHomeWidgets`). Never ranked, never sunset; the calm
backdrop a brand-new account still sees.

### Tier 2 — Live agent work (ongoing, self-hiding)
Only work that needs the user's response belongs here:
`needs-attention.pending`, plus setup-progress cards such as
`model-download.status` and `agent-provisioning.status`. These rank by
`approval`/`escalation`/setup signals and self-hide when idle. Continuous
activity streams, app-run lists, and running workflow lists stay in the
launcher/sidebar/routed views.

### Tier 3 — Data attention (urgency from the widget's own data)
Calendar, goals, health, todos, and wallet. Each fetches its own data,
self-publishes a `home-attention` weight while a condition holds, and self-hides
otherwise where appropriate. Finances, inbox, relationships, feed activity,
workflow activity, and orchestrator app/activity cards do not live on home; use
their launcher/routed surfaces.

### Tier 4 — Transient guidance (show-once-then-sunset)
FTU welcome, connector nudges, the tutorial nudge. These rank for a cold user
but **retire permanently** once their job is done, via the sunset lifecycle —
they are the only tier that uses it.

## The sunset lifecycle (Tier 4)

A widget opts in with a `sunset` policy on its declaration
(`HomeWidgetSunset` in `widgets/types.ts`):

| field | retire when |
|-------|-------------|
| `dismissible` | the user taps the card's dismiss control |
| `afterAction` | the user acts on it (taps a chip / follows its CTA) |
| `afterSeen: N` | the card has been shown in more than `N` sessions |

State is persisted per `homeWidgetKey` by `home-dismissal-store.ts`
(`localStorage: eliza:home-dismissed:v1`). `WidgetHost`'s `slot === "home"`
branch filters a widget out once `isHomeWidgetSunset` returns true, so a retired
card stays gone across reloads.

## The `welcome` signal kind

`HOME_SIGNAL_WEIGHTS.welcome = 8` sits **below** `approval` (9) /
`escalation` (10) / `blocked` (10) and **above** everything else. The FTU
welcome card self-publishes it so a cold home shows it at the top, yet a real
"act now" signal always outranks it. It is the only signal kind tied to the
sunset lifecycle rather than to live data.

## Removed resident cards

The following components/routes can still exist, but their `slot:"home"`
declarations are removed: `agent-orchestrator.activity`,
`agent-orchestrator.apps`, `feed.agent-activity`, `workflow.running`,
`finances.alerts`, `relationships.attention`, and `inbox.unread`.

The old `messages.recent` card also remains removed. Follow-up-worthy messages
surface through notifications, and conversation navigation lives in chat history
instead of a resident home tile.
