# Survival economics

Why this skill exists: a Eliza-style autonomous agent runs in an Eliza Cloud container, the container costs money, and earning money is how the agent stays online. This document explains the exact accounting so the agent's behavior matches the rules of the game.

## The ledger

Two tables in the cloud DB matter:

- **`credit_transactions`** — the org's purchased credit balance, debited per cloud-SDK call when no earnings are available
- **`redeemable_earnings_ledger`** — the owner's accumulated markup-cuts from every app they own; can be cashed out OR auto-applied to hosting

Every cloud-SDK call routed through a monetized app generates two ledger rows:
1. The user pays the base inference cost (debited from their org's credits)
2. The markup % goes into the app-owner's `redeemable_earnings_ledger`

The dashboard view at `https://www.elizacloud.ai/dashboard/earnings` shows the running totals.

## Container billing

Container hosting is pay-as-you-go, billed daily. The cron at `app/api/cron/container-billing/route.ts` runs once per day and, for each container:

1. Computes the day's hosting cost (CPU + RAM at the tier's per-second rate)
2. Pulls from `redeemable_earnings_ledger` first (if `pay_as_you_go_from_earnings = true`, which is the org default)
3. Falls back to `credit_transactions` if earnings are insufficient
4. If both are zero, marks the container with a `payment_overdue` warning
5. After 48 hours of `payment_overdue`, the container is stopped

This means: **as long as your app's earnings ≥ your container's hosting cost, the loop is self-sustaining.** No credit-card top-ups, no manual intervention.

## The default tier

A new container without explicit overrides runs at:

- **CPU**: 256 m
- **Memory**: 512 MB
- **Cost**: ~$0.67/day (subject to current pricing in the cloud's `container_pricing` table)

An app earning a 20% markup on roughly $3.50/day of inference activity covers hosting. That's 4–5 active chat users at modest daily usage. Empirically achievable for any app that has even a small daily-active core.

## Why earnings come before credits

This is the design choice that makes the agent autonomous:

- If hosting was paid from credits first, the owner has to keep the credit balance topped up forever — the agent depends on the human's wallet
- With earnings-first, a profitable app generates its own runway without the owner spending anything

The org's owner controls this via the `pay_as_you_go_from_earnings` flag on the org settings. When true (the default), the agent's economics are self-contained. When false, hosting always pulls from credits and earnings stay on the redemption ledger for cashout.

## What the agent should optimize for

In order:

1. **Stay online.** Earnings ≥ hosting cost. If not, prioritize work that closes that gap.
2. **Profitability margin.** Earnings significantly above hosting builds reserve, which absorbs short-term dips in usage.
3. **Diversification.** A single app is single-point-of-failure. Once one is profitable, the agent should add another to reduce dependence on any one app's traffic.

The skill itself just covers the build-and-deploy mechanics. The strategic layer (which app to build next, how to position it, when to retire one) is outside this skill.

## Honest limits

- Markup is the only revenue lever for chat-style apps in the current schema; if older code or docs reference per-message pricing, that's stale.
- Earnings credit on completed inference. Failed calls don't generate earnings.
- The redemption flow itself takes a small platform fee; the rate is shown on the dashboard at cashout time.
- Cloud's container-quota per org caps how many simultaneous containers an agent can run. `getContainerQuota()` reports the current limit.
