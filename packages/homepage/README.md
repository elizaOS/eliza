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
| `VITE_ELIZACLOUD_API_URL` | Eliza Cloud backend URL (defaults to `https://www.elizacloud.ai`) |
| `VITE_TELEGRAM_BOT_USERNAME` | Telegram bot username from @BotFather |
| `VITE_TELEGRAM_BOT_ID` | Numeric Telegram bot ID (first part of bot token before `:`) |
| `VITE_DISCORD_CLIENT_ID` | Discord Application ID (from Developer Portal → General Information) |
| `VITE_WHATSAPP_PHONE_NUMBER` | WhatsApp Business phone number in E.164 format (e.g. `+14245074963`) |

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

Build the package and publish `packages/homepage/dist` to any static host:

```bash
bun run --filter eliza-app build
```

The build copies `index.html` to `404.html` for GitHub Pages deep-link fallback. Hosts that understand `_redirects` and `_headers` can use the files in `public/` for SPA fallback and long-cache asset headers.
