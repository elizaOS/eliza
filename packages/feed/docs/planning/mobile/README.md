# Feed Mobile App

> **Status:** All code complete through Phase 3. Tested on real Pixel 10 device.  
> **Branch:** `feat/mobile`  
> **Last Updated:** February 13, 2026  

Ship Feed to iOS App Store and Android Play Store using Capacitor — without a React Native rewrite.

## Docs

| Document | Description |
|----------|-------------|
| [Strategy & Research](./01-strategy.md) | Why Capacitor, framework comparison, the decision rationale |
| [Architecture Analysis](./02-architecture.md) | Codebase audit, server page breakdown, dependency analysis, critical findings |
| [Technical Implementation](./03-implementation.md) | Static export, dynamic routes, code sharing, key technical decisions |
| [Privy & Auth](./04-privy-auth.md) | Privy Capacitor integration, OAuth flow, embedded wallet, CORS, cookie auth |
| [Native Features](./05-native-features.md) | Haptics, push notifications, status bar, deep links, app lifecycle |
| [App Store](./06-app-store.md) | Apple/Google review considerations, IAP, regulatory risks |
| [Status & Remaining](./07-status.md) | Implementation progress, remaining work, risk status, dev setup |

## Quick Start

```bash
# Build the mobile static export
cd apps/mobile
NEXT_PUBLIC_API_URL=https://play.feed.market \
NEXT_PUBLIC_PRIVY_APP_ID=<id> \
bun run build && npx cap sync && bun run generate:assets

# Dev testing (see 07-status.md for full setup)
cd apps/web && SKIP_ENV_VALIDATION=1 bun x next dev --port 3077
```

