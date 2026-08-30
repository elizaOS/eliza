# Homepage source module

React source for the public marketing surfaces embedded in `packages/app`.
This directory does not own a development server, production build, preview,
or Cloudflare Pages project; `packages/app` is the only frontend composition
root and deployable artifact for both `eliza.app` and `cloud.eliza.app`.

## Purpose / role

This package owns the public landing/download components, their assets, and
focused source and visual regression tests. The app renderer selector imports
the approved `embedded-home` root through its lightweight marketing entry and
the remaining public shell imports `embedded-downloads`; then
`packages/app/scripts/sync-homepage-assets.mjs` materializes the required public
files into the unified app build. The older route harness remains test-only so
its component coverage and reviewed visual baselines stay available; it is not
a product build or deployment authority.

## Layout

```
packages/homepage/
  edge/
    apple-app-site-association.json Reviewed production iOS association manifest (never published by Pages)
    apple-app-site-association.ts  Exact-path Cloudflare Worker for the production iOS association response
    apple-app-site-association.test.ts  Manifest, native identity, transport, and deploy contract tests
    text-modules.d.ts             Exact-text manifest import type used by the Worker
    tsconfig.json                 Standalone strict typecheck for the edge Worker
  src/
    embedded-home.tsx           Public landing entrypoint imported by packages/app
    embedded-downloads.tsx      Public downloads entrypoint imported by packages/app
    embedded-surface.tsx        Providers/styles shared by embedded public surfaces
    main.tsx                    Test-only legacy route-harness entry
    App.tsx                     Test-only legacy route table
    index.css                   Global Tailwind v4 styles
    pages/
      landing.tsx               "/" and "/leaderboard" — animated onboarding + platform switcher
      marketing.tsx             "/downloads" — download buttons, platform icons, release data
      login.tsx                 "/login" — redirects to /get-started or /connected based on auth
      get-started.tsx           "/get-started" — SMS/Telegram/Discord/WhatsApp/Solana sign-in
      connected.tsx             "/connected" — post-auth dashboard (linked platforms, sign-out)
    components/
      authed-shell.tsx          Layout wrapper for auth-gated routes (QueryProvider + AuthProvider)
      BlobButton.tsx            Animated blob CTA button
      brand/eliza-logo.tsx      Eliza SVG logo component (ElizaLogo)
      ShaderBackground/         react-three/fiber WebGL gradient wave (gradientWaveMaterial + ShaderBackground, lazy-loaded)
      ChatUI/renderChatToCanvas.ts  Canvas-rendered chat bubble surface for the onboarding demo
      ModelViewers/ModelB.tsx   3D model viewer (react-three/fiber); eager import in leaderboard
      login/phone-number-input.tsx  E.164 phone input with country picker
      login/country-flag.tsx    Country flag glyph for the phone picker
      providers/query-provider.tsx  TanStack Query client wrapper
      DocumentMetaManager.tsx   <title> / <meta> manager
      QRCode.tsx                QR code renderer (inline SVG)
      VideoCall.tsx             Video call UI component (lazy-loaded)
    lib/
      api/client.ts             Base fetch helpers (elizacloudFetch, elizacloudAuthFetch, getAuthToken, getElizacloudUrl)
      api/siws.ts               Sign-In-With-Solana (SIWS) — signInWithSolana, nonce/verify against Cloud API
      context/auth-context.tsx  AuthProvider + useAuth hook — session token in localStorage
      hooks/use-eliza-app-provisioning-chat.ts  Provisioning-chat hook for onboarding
      contact.ts                SMS / WhatsApp number constants and href builders
      query-client.ts           Shared TanStack Query client instance
      spring-types.ts           react-spring type helper
      utils.ts                  clsx / tailwind-merge utility (cn)
    providers/
      I18nProvider.tsx          i18n context + useT() / useI18n() hooks
    i18n/locales/               JSON translation files (en, es, ja, ko, pt, tl, vi, zh-CN)
    generated/
      release-data.ts           Auto-generated from GitHub Releases API — do not edit by hand
    types/
      speech-recognition.d.ts   Ambient SpeechRecognition Web API types
  public/                       Static assets plus an intentionally inert Pages AASA fallback
  wrangler-aasa.toml            Production-only route for the exact eliza.app AASA URL
  tests/
    smoke.node.test.mjs         Node --test smoke suite (the `test` script)
    contact.test.ts             SMS/WhatsApp href unit test
    e2e/                        Playwright e2e specs (aesthetic-audit, route-coverage, visual, live-routes, ...)
  scripts/
    generate-contact-sheet.mjs  Generates HTML contact sheet from Playwright screenshots
    verify-aasa-response.mjs    Separately gates exact origin and Apple CDN bytes, metadata, identity, and routes
  vite.config.ts                Test-harness Vite config; never used for product builds
  playwright.config.ts          Isolated visual-regression harness configuration
```

## Key exports / surface

This package is private and has no published exports. `packages/app` consumes
its embedded entrypoints through an explicit source alias; no other package may
treat it as an application or deploy its output.

**Internal alias `@/`** maps to `src/`. Vite aliases resolve `@elizaos/ui/*` sub-paths directly to source files in `packages/ui/src/` to avoid pulling the full barrel.

## Commands

Source-validation scripts are run with `bun run --cwd packages/homepage <script>`.

```bash
bun run --cwd packages/homepage typecheck      # tsc -b (generates release-data first)
bun run --cwd packages/homepage lint           # Biome check --write --unsafe
bun run --cwd packages/homepage lint:check     # Biome check (read-only)
bun run --cwd packages/homepage format         # Biome format --write
bun run --cwd packages/homepage format:check   # Biome format (read-only)
bun run --cwd packages/homepage test           # Node --test smoke suite
bun run --cwd packages/homepage test:aasa-edge # AASA body/header/origin-pass-through contract
bun run --cwd packages/homepage typecheck:aasa-edge # Strict standalone edge Worker typecheck
bun run --cwd packages/homepage deploy:aasa-edge # Deploy exact-path production Worker (requires Cloudflare credentials)
bun run --cwd packages/homepage test:e2e       # Optional isolated source visual harness; never deploys
bun run --cwd packages/homepage test:audit     # Optional source aesthetic audit + contact sheet
bun run --cwd packages/homepage check:release-data  # Validate generated release-data.ts
```

Run the product surface through `bun run --cwd packages/app dev` and build it
with `bun run --cwd packages/app build:web`. The app's `predev`/`prebuild`
generates homepage release data and syncs the approved homepage assets before
Vite starts. The Cloudflare workflow builds only that app artifact.

## Config / env vars

These `VITE_` variables are read by the embedded source. Configure them on the
`packages/app` build; `.env.local` in this package is only for the optional
isolated visual harness.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_ELIZACLOUD_API_URL` | `https://api.eliza.app` | Eliza Cloud backend base URL |
| `VITE_TELEGRAM_BOT_USERNAME` | `ElizaIsNotABot` | Local/direct-build Telegram username fallback; with the ID, the repository-scoped staging release authority |
| `VITE_TELEGRAM_BOT_ID` | `8931353359` | Local/direct-build numeric Telegram ID fallback; with the username, the repository-scoped staging release authority |
| `VITE_DISCORD_CLIENT_ID` | `1468649258654630063` | Optional Discord Application ID override |
| `WHATSAPP_PUBLIC_ENABLED` | disabled | Deployment-only switch that admits the public WhatsApp CTA |
| `VITE_WHATSAPP_PHONE_NUMBER` | — | Admitted Blooio WhatsApp sender (E.164); production uses the shared `+18087881821` number only after its WhatsApp channel passes live proof |

Auth token is stored in `localStorage` under key `eliza_app_session`. The test signer hook is `window.__siwsTestSigner` (used by Playwright e2e to skip wallet interaction).

The Telegram defaults above do not authorize a protected staging Pages
artifact. The Cloud release preflight requires the explicit, valid repository
pair before staging migrations or API deployment, and neither component may
match production. Production ignores the repository pair and derives its exact
identity from `src/lib/contact.ts` at the checked-out release SHA. Do not treat
same-named GitHub Environment variables as overrides: they arrive after the
repository `vars` context has already been resolved.

## How to extend

**Add or change a public product route:** update the source component here,
expose a narrow embedded entrypoint, and register that entrypoint in the
`packages/app` web shell. Do not add a second application entry or deployment
configuration. Authentication and Cloud management routes belong to the
unified router in `@elizaos/ui`.

**Add a new i18n locale:**
1. Add `src/i18n/locales/<locale>.json` following the existing key structure.
2. Register the locale in `src/providers/I18nProvider.tsx`.

**Update release download data:**
Run `node packages/app-core/scripts/write-homepage-release-data.mjs` — this is
done automatically by the `packages/app` predev/prebuild lifecycle.

**Add a new API call:**
Use `elizacloudFetch` (public) or `elizacloudAuthFetch` (sends Bearer token) from `src/lib/api/client.ts`. Do not call `fetch` directly.

## Conventions / gotchas

- **`src/generated/release-data.ts` is auto-generated.** Never edit it by hand; it is overwritten on every `dev`/`build`. Run the generator script if you need fresh data.
- **Vite aliases resolve `@elizaos/ui` sub-paths to source.** There is no bare `@elizaos/ui` alias; only explicit sub-path aliases (`@elizaos/ui/cloud-ui`, `@elizaos/ui/button`, `@elizaos/ui/input`, `@elizaos/ui/dropdown-menu`, `@elizaos/ui/i18n/region`, `@elizaos/ui/product-switcher`) map to `packages/ui/src/`. Use those sub-path imports; adding a new sub-path requires a new alias entry in `vite.config.ts`.
- **ShaderBackground and VideoCall are lazy-loaded** in `landing.tsx` (`React.lazy()` + `Suspense`) so the route shell becomes interactive without waiting for the WebGL/canvas code. `ModelB` sits behind its own Suspense boundary because it drives the messaging surface but must not block the page chrome while its 3D asset loads.
- **`packages/app` is the only frontend host.** Do not restore homepage
  `dev`, `build`, `preview`, or Pages deployment scripts. Public headers,
  redirects, assets, and Functions behavior must be emitted by the app.
- **Port 4444 belongs only to the optional Playwright source harness.** Normal
  development uses `packages/app`; `bun run dev:all` never launches this package.
- **The production AASA response is owned by the exact-path Worker** in `edge/apple-app-site-association.ts`; it serves the exact bytes of the reviewed edge-only JSON manifest and forwards every non-exact request to the existing Pages origin. The public AASA file deliberately keeps its placeholder Team ID so `develop` Pages builds cannot publish production trust. `.github/workflows/deploy-aasa.yml` publishes only from protected `main`, rolls back an invalid origin before observing Apple's CDN in a separate job, and never treats cache-bypass behavior as release evidence.
- **SIWS test signer:** Playwright e2e injects `window.__siwsTestSigner` to simulate Solana wallet sign-in without a real wallet extension.
- For logging, architecture, and naming conventions see the root `CLAUDE.md`.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's source typecheck/lint/tests and build `packages/app`, then exercise
the real unified-host boundary. Inspect the produced app artifact and failure
behavior; a test-harness Vite render is not deployment evidence.
