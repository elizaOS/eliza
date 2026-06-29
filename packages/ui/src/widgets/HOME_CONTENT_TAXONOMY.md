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
What the agent is doing *right now*: `agent-orchestrator.activity`,
`agent-orchestrator.apps`, `workflow.running`, `needs-attention`. Ranked by
`blocked`/`escalation`/`approval`/`workflow` signals; self-hides when idle. These
are NOT chat echoes — they are live work state.

### Tier 3 — Data attention (urgency from the widget's own data)
Calendar, finances, goals, health, inbox, relationships. Each fetches its own
data, self-publishes a `home-attention` weight while a condition holds (an
overdrawn balance, an event in 10 minutes), and self-hides otherwise.

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

## `messages.recent` — kept, not a chat echo

The "Recent conversations" tile (`messages.recent`) is a **launcher into past
threads**, not a live mirror of the active chat overlay (the topic's "home must
not echo chat" rule targets a live transcript echo, which the home does not
have). It stays in Tier 2/3 as a navigational affordance. If a live-transcript
echo is ever added to the home, it must be removed under this rule.
