Static React + Vite SPA for the Eliza homepage. Calls the Eliza Cloud API directly. No Next.js, no proxy.

## Getting Started

### 1. Environment Setup

Copy the example environment file and fill in the values:

```bash
cp .env.example .env.local
```

**Key variables** (Vite uses the `VITE_` prefix; only `VITE_*` vars are exposed to the browser):

| Variable | Description |
|---|---|
| `VITE_ELIZACLOUD_API_URL` | Eliza Cloud backend URL (defaults to `https://elizacloud.ai`) |
| `VITE_TELEGRAM_BOT_USERNAME` | Telegram bot username from @BotFather |
| `VITE_TELEGRAM_BOT_ID` | Numeric Telegram bot ID (first part of bot token before `:`) |
| `VITE_DISCORD_CLIENT_ID` | Discord Application ID (from Developer Portal → General Information) |
| `VITE_WHATSAPP_PHONE_NUMBER` | WhatsApp Business phone number in E.164 format (defaults to `+14159611510`) |

### Discord OAuth2 Setup

Register your redirect URI in the Discord Developer Portal:

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application (matching `VITE_DISCORD_CLIENT_ID`)
3. Navigate to **OAuth2** → **Redirects** and add:
   ```
   http://localhost:4444/get-started
   ```
   Add a corresponding entry for each deployed origin (e.g. `https://eliza.app/get-started`).

### 2. Run the Development Server

```bash
bun install
bun run dev
```

Open [http://localhost:4444](http://localhost:4444) — Vite hot-reloads on save.

### 3. Build

```bash
bun run build      # outputs static assets to ./dist
bun run preview    # serves ./dist locally on :4444
```

## Deploy

The homepage is hosted only on the `eliza-app-home` Cloudflare Pages project.
Wrangler uses the authenticated Cloudflare account or the repository's
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets:

```bash
bun run --cwd packages/homepage deploy:preview
bun run --cwd packages/homepage deploy:production
```

Cloudflare Pages consumes `public/_redirects` for SPA deep links and
`public/_headers` for cache and security headers. The deploy workflow publishes
`packages/homepage/dist` after the build and browser suites pass.

### Canonical domains

The domain map lives in `@elizaos/shared/brand` as `EXTERNAL_URLS`:

| Surface | Origin |
|---|---|
| Marketing homepage | `https://eliza.app` |
| Hosted Eliza web app | `https://app.elizacloud.ai` |
| Eliza Cloud console | `https://elizacloud.ai` |
| elizaOS downloads | `https://os.eliza.app` |
| Docs | `https://docs.elizaos.ai` |

`eliza.app` and `www.eliza.app` are custom domains on `eliza-app-home`.
`os.eliza.app` is a custom domain on the existing `elizaos-homepage` Pages
project. `elizaos.ai` remains unchanged until its later redirect.
