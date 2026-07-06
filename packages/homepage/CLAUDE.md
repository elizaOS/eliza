# eliza-app

Static React + Vite SPA that serves as the elizaOS public homepage (`eliza.app`). Calls the Eliza Cloud API directly from the browser — no proxy, no Next.js, no server-side rendering.

## Purpose / role

This package builds and deploys the public-facing marketing site and user onboarding flow for elizaOS. It is not imported by any other package; it is a standalone Vite app that produces `dist/` for deployment to GitHub Pages or Cloudflare Pages. It consumes `@elizaos/ui` and `@elizaos/shared` from the monorepo workspace.

## Layout

```
packages/homepage/
  src/
    main.tsx                    App entry — mounts <App> under StrictMode + I18nProvider
    App.tsx                     Route table (BrowserRouter + React Router)
    index.css                   Global Tailwind v4 styles
    pages/
      marketing.tsx             "/" — download buttons, platform icons, release data
      leaderboard.tsx           "/leaderboard" — animated onboarding + platform tab switcher
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
  public/                       Static assets (logos, favicons, OG images, install scripts)
  tests/
    smoke.node.test.mjs         Node --test smoke suite (the `test` script)
    contact.test.ts             SMS/WhatsApp href unit test
    e2e/                        Playwright e2e specs (aesthetic-audit, route-coverage, visual, live-routes, ...)
  scripts/
    generate-contact-sheet.mjs  Generates HTML contact sheet from Playwright screenshots
  vite.config.ts                Vite config — aliases, gh404Fallback plugin, bundle visualizer
  playwright.config.ts          Playwright config for e2e
```

## Key exports / surface

This package has no library exports. It is a private Vite application (`"private": true`). Other packages do not import from it.

**Internal alias `@/`** maps to `src/`. Vite aliases resolve `@elizaos/ui/*` sub-paths directly to source files in `packages/ui/src/` to avoid pulling the full barrel.

## Commands

All scripts are run with `bun run --cwd packages/homepage <script>`.

```bash
bun run --cwd packages/homepage dev            # Vite dev server on :4444 (runs predev first)
bun run --cwd packages/homepage build          # Production build → dist/ (runs prebuild first)
bun run --cwd packages/homepage clean          # Remove dist/
bun run --cwd packages/homepage preview        # Serve dist/ on :4444
bun run --cwd packages/homepage typecheck      # tsc -b (generates release-data first)
bun run --cwd packages/homepage lint           # Biome check --write --unsafe
bun run --cwd packages/homepage lint:check     # Biome check (read-only)
bun run --cwd packages/homepage format         # Biome format --write
bun run --cwd packages/homepage format:check   # Biome format (read-only)
bun run --cwd packages/homepage test           # Node --test smoke suite
bun run --cwd packages/homepage test:e2e       # Playwright e2e (all specs)
bun run --cwd packages/homepage test:audit     # Aesthetic audit + contact sheet
bun run --cwd packages/homepage check:release-data  # Validate generated release-data.ts
```

**predev / prebuild** run automatically before `dev` and `build`:
1. `node ../shared/scripts/sync-to-public.mjs ./public --logos --favicons --ogembeds --background --background-videos` — syncs brand assets into `public/`.
2. `node ../app-core/scripts/write-homepage-release-data.mjs` — fetches GitHub Releases and writes `src/generated/release-data.ts`.

## Config / env vars

All vars use the `VITE_` prefix (browser-exposed). Set in `.env.local`.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_ELIZACLOUD_API_URL` | `https://www.elizacloud.ai` | Eliza Cloud backend base URL |
| `VITE_TELEGRAM_BOT_USERNAME` | — | Telegram bot username (from @BotFather) |
| `VITE_TELEGRAM_BOT_ID` | — | Numeric Telegram bot ID |
| `VITE_DISCORD_CLIENT_ID` | — | Discord Application ID for OAuth2 |
| `VITE_WHATSAPP_PHONE_NUMBER` | `+14159611510` | WhatsApp Business number (E.164) |

Auth token is stored in `localStorage` under key `eliza_app_session`. The test signer hook is `window.__siwsTestSigner` (used by Playwright e2e to skip wallet interaction).

## How to extend

**Add a new route:**
1. Create `src/pages/<name>.tsx`.
2. Add a `lazy(() => import("@/pages/<name>"))` in `src/App.tsx`.
3. Add the `<Route>` entry; wrap in `<AuthedShell>` if auth is required.
4. Add a Playwright route entry in `tests/e2e/route-coverage.spec.ts` and `aesthetic-audit.spec.ts`.

**Add a new i18n locale:**
1. Add `src/i18n/locales/<locale>.json` following the existing key structure.
2. Register the locale in `src/providers/I18nProvider.tsx`.

**Update release download data:**
Run `node packages/app-core/scripts/write-homepage-release-data.mjs` — this is done automatically by predev/prebuild.

**Add a new API call:**
Use `elizacloudFetch` (public) or `elizacloudAuthFetch` (sends Bearer token) from `src/lib/api/client.ts`. Do not call `fetch` directly.

## Conventions / gotchas

- **`src/generated/release-data.ts` is auto-generated.** Never edit it by hand; it is overwritten on every `dev`/`build`. Run the generator script if you need fresh data.
- **Vite aliases resolve `@elizaos/ui` sub-paths to source.** There is no bare `@elizaos/ui` alias; only explicit sub-path aliases (`@elizaos/ui/cloud-ui`, `@elizaos/ui/button`, `@elizaos/ui/input`, `@elizaos/ui/dropdown-menu`, `@elizaos/ui/i18n/region`, `@elizaos/ui/product-switcher`) map to `packages/ui/src/`. Use those sub-path imports; adding a new sub-path requires a new alias entry in `vite.config.ts`.
- **ShaderBackground and VideoCall are lazy-loaded** in `leaderboard.tsx` (`React.lazy()` + `Suspense`) so the route shell becomes interactive without waiting for the WebGL/canvas code. `ModelB` is imported eagerly because it drives the messaging surface on first paint — but it pulls in `three`/`@react-three/fiber`, so don't add more eager `three` imports elsewhere.
- **GitHub Pages deep-link fallback:** The `gh404Fallback` Vite plugin copies `index.html` → `404.html` at build time. `public/_redirects` and `public/_headers` serve the same purpose on Cloudflare Pages.
- **`CF_PAGES=1` disables the 404.html copy** — set this env var when building for Cloudflare Pages.
- **Dev server port is 4444** (not the standard 5173). `bun run dev` is required; `vite preview` alone will not have the correct env from the orchestrator.
- **SIWS test signer:** Playwright e2e injects `window.__siwsTestSigner` to simulate Solana wallet sign-in without a real wallet extension.
- For logging, architecture, and naming conventions see the root `AGENTS.md`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — docs / site:**
- The site built and the changed pages **rendered**, with before/after screenshots (desktop + mobile).
- Link/redirect checks that actually resolve, and any embedded examples that actually run.
- For redirects: the real HTTP redirect chain captured.
<!-- END: evidence-and-e2e-mandate -->
