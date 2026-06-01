# elizaOS OS homepage

Landing page for elizaOS — the agentic operating system. Covers beta OS downloads, elizaOS hardware pre-orders, and the hardware checkout flow.

Production URL: `https://os.elizacloud.ai`
Cloudflare Pages project: `elizaos-homepage`

## What it includes

- **Hero + download section** — fetches a beta release manifest from `/downloads/elizaos-beta-manifest.json` at runtime and renders per-platform download cards (Linux, Android, macOS, Windows). Falls back to a hardcoded manifest if the fetch fails.
- **Hardware catalog** — product tiles driven by the shared hardware catalog (`packages/shared/src/hardware-catalog`). Links to per-product detail pages at `/hardware/:slug`.
- **Pre-order checkout** — auth via Eliza Cloud (magic link or OAuth: Google, GitHub, Discord), then a Stripe-hosted payment page. Checkout result pages at `/checkout/success` and `/checkout/cancel`.
- **i18n** — 8 locales (en, zh-CN, ko, es, pt, vi, tl, ja). English strings are inlined as `defaultValue` at every call site; other locales lazy-load from `src/i18n/locales/`.

## Dev

```bash
# Install deps from repo root
bun install

# Start dev server (also syncs brand assets from @elizaos/shared)
bun run --cwd packages/os-homepage dev
```

Dev server runs on `:4455`.

## Build and deploy

```bash
bun run --cwd packages/os-homepage build
bun run --cwd packages/os-homepage deploy
```

The deploy target is the `elizaos-homepage` Cloudflare Pages project. The custom domain `os.elizacloud.ai` must be pointed at the Pages project with a CNAME before Cloudflare can complete custom-domain verification.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VITE_ELIZA_CLOUD_API_URL` | `https://api.elizacloud.ai` | Cloud API base for auth and checkout |

## Tests

```bash
# Node smoke test (no browser required)
bun run --cwd packages/os-homepage test

# Playwright e2e
bun run --cwd packages/os-homepage test:e2e
```

For agent-facing documentation (file layout, extension guides, gotchas), see [CLAUDE.md](CLAUDE.md).
