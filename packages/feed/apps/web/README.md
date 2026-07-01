# Feed Web (`apps/web`)

Next.js application: UI, API routes, SSE, auth wiring, and Vercel Analytics/Speed Insights.

## Observability

- **Vercel Analytics / Speed Insights** are opt-in via `NEXT_PUBLIC_ENABLE_VERCEL_OBSERVABILITY=1`. Railway production leaves this unset so `_vercel/*` scripts are not mounted from a non-Vercel host.
- **Vercel Speed Insights** (real-user Web Vitals) is wrapped in **`GatedSpeedInsights`**: route allowlist + session sampling + optional disable for minimal/embed layout.
- **Why documented centrally:** Operators tune sampling without reading layout code; rationale for allowlists and defaults lives in one place.

Full write-up (WHYs, env vars, route list, follow-ups): [`docs/observability/speed-insights.md`](../../docs/observability/speed-insights.md).

## Related docs

| Topic | Location |
|-------|----------|
| Observability index | [`docs/observability/README.md`](../../docs/observability/README.md) |
| Markets / terminal (example feature README) | [`src/app/markets/README.md`](./src/app/markets/README.md) |

## Commands

From repo root:

```bash
bun run dev:web    # This app only
bun run build      # Production build (turbo)
```

See root [`README.md`](../../README.md) for full quality gates and monorepo commands.
