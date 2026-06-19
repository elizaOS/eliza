# Dashboard Index Redesign

`/dashboard` (`src/dashboard/Page.tsx`) is the first authenticated surface a
user sees. The legacy version showed a hero, a 5-card action strip
(`DashboardActionCards`), and a 4-up "My Agents" grid. It mixed marketing
copy, brand-blue chrome, and orange→black hover transitions, and surfaced
no real state about the user's account.

## Audiences (single page, four hats)

1. **App creators** — building monetized apps. Want app health + earnings.
2. **Agent operators** — running Eliza agents. Want container/agent status.
3. **Inference customers** — using the model gateway. Want credit balance + API keys.
4. **Affiliates** — referring users. Want a referral link they can copy.

## Signal > noise: 6 things on first load

1. **Greeting + credit balance** — what's in the wallet right now.
2. **Top-up CTA** — single primary action for inference customers.
3. **Agents snapshot** — count and a "Manage" affordance.
4. **Containers snapshot** — running / total instances.
5. **Apps snapshot** — count of deployed apps and a link to monetization.
6. **API keys + Earnings + Referrals row** — three small, low-priority chips.

Everything deeper (analytics, billing history, security, admin) lives behind
the sidebar; the index does not duplicate it.

## Layout (ASCII)

```
+--------------------------------------------------------------+
| Eyebrow: elizaOS Platform / Eliza Cloud                      |
| H1: Welcome back, <name>                                     |
| Sub: One-line status (e.g. "<n> agents, $X balance")         |
+--------------------------------------------------------------+

+-------------------- Balance (wide) ------+-- Top up (CTA) ---+
| $12.34                                   |  Add credits  →   |
| Credit balance                           |                   |
+------------------------------------------+-------------------+

+-- Agents (2x) ---------+-- Containers ---+-- Apps ----------+
| 3 agents               | 2 / 3 running   | 1 deployed       |
| [Manage]               | [Instances]     | [Apps]           |
+------------------------+-----------------+------------------+

+-------------- Agents Grid (existing AgentsSection) ----------+
+--------------------------------------------------------------+

+-- API keys ---+-- Earnings ---+-- Referrals ---+-- Docs -----+
| 2 keys        | View          | Copy link      | Read        |
+---------------+---------------+----------------+-------------+
```

## Card spec

| Card        | Hook / source                       | Empty state           | Skeleton          | Primary CTA              |
| ----------- | ----------------------------------- | --------------------- | ----------------- | ------------------------ |
| Balance     | `useCreditsBalance()`               | "—" + Add credits     | Pulse on number   | `/dashboard/billing`     |
| Top-up      | static                              | n/a                   | n/a               | `/dashboard/billing`     |
| Agents      | existing `useDashboardData`         | "No agent yet"        | Existing skeleton | `/dashboard/my-agents`   |
| Containers  | `useContainers()`                   | "0 instances"         | Pulse on counts   | `/dashboard/containers`  |
| Apps        | `useApps()`                         | "No apps yet"         | Pulse on counts   | `/dashboard/apps`        |
| API keys    | `useApiKeys()`                      | "0 keys"              | Pulse on number   | `/dashboard/api-keys`    |
| Earnings    | static link                         | n/a                   | n/a               | `/dashboard/earnings`    |
| Referrals   | `useDashboardReferralMe()`          | "Generate link"       | Pulse             | copy referral URL        |
| Docs        | static link                         | n/a                   | n/a               | `/docs`                  |

All numeric stats are rendered from authoritative server responses; no
client-side computation beyond formatting (`toFixed`, `length`, simple
counts of an already-fetched array). No fallback `?? 0` math that would
hide a broken pipeline — when a query errors, the card shows "—".

## What's omitted (and why)

- **Marketing copy / pitch headline** — this is an authenticated console,
  not a landing page. The header is the user's name + status.
- **Analytics charts** — `useAnalyticsBreakdown` is heavy and belongs on
  `/dashboard/analytics`. Surfacing one chart here would duplicate it.
- **Billing/invoices list** — already on `/dashboard/billing` and
  `/dashboard/invoices`.
- **Security panel** — settings live in `/dashboard/security`.
- **Admin chrome** — admins reach it via the sidebar.
- **App creation wizard** — the Apps card links to the dedicated route.
- **`DashboardActionCards`** — the existing brand card strip mixes blue
  (`#0B35F1`) and orange→black hover, both forbidden by the redesign
  constraints. We rebuild a smaller, monochrome+orange variant inline.

## Colors & hover

- Neutral: `bg-white/[0.04]`, border `border-white/10`, text `text-white`
  with `text-white/60` for muted lines.
- Accent: `#FF5800` for the single primary balance/CTA card.
- Hover:
  - Orange resting → `hover:bg-[#E04E00]` (darker orange).
  - Neutral resting → `hover:bg-white/[0.06]` (subtle white opacity).
  - **No** orange→black, **no** blue anywhere.

## Reuse

- `AgentsSection` / `AgentsSectionSkeleton` — kept verbatim.
- `DashboardPageWrapper`, `DashboardPageContainer`, `DashboardPageStack`,
  `DashboardLoadingState` — kept.
- `BrandButton`, `BrandCard` — for buttons and the framed cards.
- Hooks: `useCreditsBalance`, `useContainers`, `useApps`, `useApiKeys`,
  `useDashboardReferralMe`, plus the existing `/api/v1/dashboard` fetch
  for agents.

No new endpoints, no new dependencies.
