# Vercel Speed Insights (real user monitoring)

Babylon uses [@vercel/speed-insights](https://vercel.com/docs/speed-insights) on the Next.js app (`apps/web`) to collect **Core Web Vitals** and related performance signals from real browsers.

Instrumentation is implemented in **`GatedSpeedInsights`** (`apps/web/src/components/observability/GatedSpeedInsights.tsx`) and mounted from the root layout (and mirrored in the legacy full shell client for consistency).

---

## Why gate routes?

**Problem:** With `<SpeedInsights />` in the root layout, **every navigation** can produce RUM datapoints. High-traffic apps pay for volume and noise: admin pages, settings, agent builders, and embeds rarely need the same perf regression signal as the main game surfaces.

**Approach:** A `beforeSend` hook drops vitals whose URL pathname is **not** on an allowlist of high-signal routes (feed, markets, wallet, profiles, etc.). Product and engineering still see **LCP / INP / CLS** where UX and revenue matter most, without funding a complete census of every screen.

**Caveat:** After the Speed Insights script loads (typically on a user’s first visit to an allowed route in a session), the script remains in the page. **Gating is event-level** (we discard disallowed routes), not “never download the SDK on other routes.” That is enough to cut **billable datapoints** materially while keeping implementation simple and reliable.

---

## Why sample (percentage)?

**Problem:** Even on key routes, **100% sampling** multiplies events with traffic spikes (viral posts, bots, refresh-heavy trading UIs). Vercel bills Speed Insights on usage tiers tied to datapoint volume.

**Approach:** We pass Vercel’s supported **`sampleRate`** (0–1 internally), driven by a single env var expressed as **0–100** so operators think in “percent of sessions,” not decimals.

**Why default 50% when unset:** A single default has to balance **statistical usefulness** (enough samples to see regressions within days, not months) against **cost**. Fifty percent is a deliberate compromise: teams that need tighter monitoring can set `100`; cost-sensitive deploys can set `10` or `20` without code changes.

**Why clamp 0–100:** Prevents misconfiguration (`200` or negative values) from producing invalid SDK input or surprising behavior. `0` effectively disables vitals reporting for sampled traffic (script may still load; see Vercel docs for edge behavior).

---

## Why disable on minimal layout?

Some responses use the **`x-minimal-layout: 1`** header (embeds / stripped chrome). Those surfaces are not representative of the main app shell (different layout, fewer assets). **Why skip RUM there:** Avoid polluting aggregates with incomparable LCP/CLS and avoid paying for instrumentation on low-product-value views.

---

## Configuration

| Variable | Meaning |
|----------|---------|
| `NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE` | Optional. **Integer or float from 0 to 100** = percentage of sessions that report vitals. **Unset → 50** (50%). |

Examples:

```bash
# Default in code when variable is omitted: 50
# Explicit examples:
NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE=100   # full sampling on allowed routes
NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE=25    # quarter of sessions
NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE=0     # no vitals (maximum savings)
```

**Migration note:** If an older deployment used a **fraction** (e.g. `0.15` meaning “15%”), that value is now interpreted as **0.15%**. Update to **`15`** for fifteen percent.

---

## Allowed routes (high signal)

The allowlist lives in code as `TRACKED_ROUTE_PREFIXES` plus the homepage `/`. **Why these:** They combine high **traffic**, **latency sensitivity** (trading, chat, feed), or **acquisition** (share links, articles).

To add a route: edit `GatedSpeedInsights.tsx` and extend the list (prefer path **prefixes** so dynamic segments stay covered). Update this doc in the same PR so operators know what is measured.

---

## Local development

Speed Insights **does not send production telemetry in development** (Vercel SDK behavior). You will still see the debug script path when running `next dev`; use a preview/production deploy to validate sampling.

---

## Roadmap

Ordered by likely value vs. effort:

1. **Env-driven route allowlist (optional)** — Why: Some teams want marketing-only or “checkout-only” measurement without redeploying. A `NEXT_PUBLIC_SPEED_INSIGHTS_ROUTES` comma-separated prefix list could override defaults; empty = use code defaults. **Risk:** Env mistakes silently drop all routes — needs validation logging in dev only.

2. **Defer script injection until first allowed route** — Why: Fewer bytes and less third-party work on cold loads to settings-only flows. **Tradeoff:** First vitals on a deep-linked allowed page might be slightly delayed; must not break Next’s `SpeedInsights` expectations.

3. **Dashboard alignment** — Why: If Vercel adds first-class sampling controls in the project UI, we should document precedence (env vs. dashboard) to avoid double-effective sampling confusion.

4. **Correlation with Sentry / PostHog** — Why: Tie Web Vital regressions to release version or experiments. Depends on stable `release` and environment tags elsewhere in the stack.

---

## References

- Vercel: [Speed Insights](https://vercel.com/docs/speed-insights)
- Package: `@vercel/speed-insights` — `sampleRate`, `beforeSend` on `<SpeedInsights />` (see `node_modules/@vercel/speed-insights/dist/next/index.d.ts`)
