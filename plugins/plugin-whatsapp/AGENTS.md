# @elizaos/plugin-whatsapp

WhatsApp connector for elizaOS agents — supports WhatsApp Cloud API (Meta Business) and Baileys (QR-code personal account auth).

## Purpose / Role

Adds WhatsApp messaging to any Eliza agent. The plugin registers `WhatsAppConnectorService` (the main send/receive engine) and `WhatsAppWorkflowCredentialProvider` (supplies credentials to the workflow plugin). It is **opt-in**: the plugin auto-enables when a `connectors.whatsapp` block is present in agent config and not explicitly disabled, or it can be loaded manually in a character file.

## Plugin Surface

### Services
| Name | Class | Description |
|------|-------|-------------|
| `whatsapp` | `WhatsAppConnectorService` | Manages Cloud API and Baileys clients, routes inbound messages through `runtime.messageService`, exposes `sendMessage`, webhook verification, and the full `MessageConnector` protocol |
| `workflow_credential_provider` | `WhatsAppWorkflowCredentialProvider` | Resolves `whatsAppApi` credentials (access token + phone number ID) for the workflow plugin |

### Routes (registered with `rawPath: true`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/whatsapp/webhook` | Meta webhook subscribe verification (public, no auth) |
| POST | `/api/whatsapp/webhook` | Incoming Meta webhook events; validates `X-Hub-Signature-256` before dispatch |
| POST | `/api/whatsapp/pair` | Start a Baileys QR-pairing session (writes auth state, updates connector config on connect) |
| GET | `/api/whatsapp/status` | Pairing session + service connection status |
| POST | `/api/whatsapp/pair/stop` | Cancel an active pairing session |
| POST | `/api/whatsapp/disconnect` | Logout and remove Baileys auth state |

### Connector Capabilities
`WhatsAppConnectorService` registers with `runtime.registerMessageConnector` with capabilities: `send_message`, `read_messages`, `search_messages`, `send_reaction`, `contact_resolution`, `chat_context`, `get_user`. Supported target kinds: `phone`, `contact`, `user`, `group`, `room`.

### No actions or evaluators
`actions: []` — messaging is surfaced through the connector protocol, not standalone plugin actions.

## Layout

```
plugins/plugin-whatsapp/
  src/
    index.ts                   Plugin entry: registers plugin object, re-exports public API
    runtime-service.ts         WhatsAppConnectorService — core send/receive engine, multi-account support
    setup-routes.ts            HTTP routes for webhook + QR pairing
    connector-account-provider.ts  ConnectorAccountManager adapter (list/create/patch/delete accounts)
    workflow-credential-provider.ts  Supplies whatsAppApi credentials to workflow plugin
    config.ts                  TypeScript config types (WhatsAppChannelConfig, WhatsAppAccountConfig, etc.)
    accounts.ts                Multi-account resolution: resolveWhatsAppAccount, listEnabledWhatsAppAccounts
    pairing-service.ts         WhatsAppPairingSession — Baileys QR pairing state machine
    normalize.ts               Phone/JID normalization utilities (normalizeE164, chunkWhatsAppText, etc.)
    media.ts                   Media URL validation helpers (assertValidWhatsAppMediaLink)
    types.ts                   Raw transport types (NormalizedMessage, WhatsAppWebhookEvent, etc.)
    webhook-auth.ts            X-Hub-Signature-256 verification helper
    client.ts                  WhatsAppClient — Cloud API HTTP client
    clients/
      factory.ts               ClientFactory.create() — selects BaileysClient or WhatsAppClient
      baileys-client.ts        Baileys (personal WA) WebSocket client
      interface.ts             IWhatsAppClient interface
    api/
      whatsapp-routes.ts       QR-flow route helpers (applyWhatsAppQrOverride, handleWhatsAppRoute)
    services/                  Additional service helpers
    baileys/                   Baileys-specific auth/store adapters
    utils/                     config-detector, misc helpers
  auto-enable.ts               Auto-enable check (shouldEnable); env-read only, no service init
  package.json
  build.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-whatsapp build        # compile dist/
bun run --cwd plugins/plugin-whatsapp dev          # hot-reload build (bun --hot)
bun run --cwd plugins/plugin-whatsapp test         # vitest run
bun run --cwd plugins/plugin-whatsapp typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-whatsapp lint         # biome check --write
bun run --cwd plugins/plugin-whatsapp format       # biome format --write
bun run --cwd plugins/plugin-whatsapp clean        # rm -rf dist .turbo
```

## Config / Env Vars

Config is read from `runtime.getSetting(key)` first, then `process.env[key]`. All keys are listed in `agentConfig.pluginParameters` in `package.json`.

### Cloud API (Meta Business) transport
| Env var | Required | Description |
|---------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | Yes | Long-lived Cloud API access token from Meta Business Manager |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | Phone number ID registered in Meta Business |
| `WHATSAPP_APP_SECRET` | Yes (webhooks) | App Secret for `X-Hub-Signature-256` verification on webhook POSTs |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | No | Token for Meta's one-time GET webhook subscribe handshake |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | No | WABA ID (informational) |
| `WHATSAPP_API_VERSION` | No | Graph API version string (default: v24.0) |

### Baileys (personal account / QR) transport
| Env var | Required | Description |
|---------|----------|-------------|
| `WHATSAPP_AUTH_DIR` | Yes (Baileys) | Directory for multi-file Baileys auth state |
| `WHATSAPP_SESSION_PATH` | No | Alternative name for `WHATSAPP_AUTH_DIR` |
| `WHATSAPP_AUTH_METHOD` | No | Force transport (`cloudapi` / `baileys`); overrides auto-detection |

### Access control (both transports)
| Env var | Default | Description |
|---------|---------|-------------|
| `WHATSAPP_DM_POLICY` | `pairing` | `open` / `allowlist` / `pairing` / `disabled` |
| `WHATSAPP_GROUP_POLICY` | `allowlist` | `open` / `allowlist` / `disabled` |
| `WHATSAPP_ALLOW_FROM` | — | Comma-separated E.164 numbers for DM allowlist |
| `WHATSAPP_GROUP_ALLOW_FROM` | — | Comma-separated E.164 numbers for group sender allowlist |

### Agent behavior
| Env var | Default | Description |
|---------|---------|-------------|
| `WHATSAPP_AUTO_REPLY` | `false` | When `true`, inbound messages trigger agent reply. Off by default — messages are stored in memory only unless auto-reply is explicitly enabled or the connector is invoked via the message connector protocol |

### Multi-account (character settings only)
Configure multiple accounts under `character.settings.whatsapp.accounts.<id>` using the fields from `WhatsAppAccountConfig` (`src/config.ts`). Each account entry mirrors the env-var fields above plus display name, per-group config, and chunking options.

## How to Extend

### Add a new route
1. Write a handler `async function handleX(req, res, runtime)` in `src/setup-routes.ts` or a new file.
2. Add a `Route` entry to `whatsappSetupRoutes` with `rawPath: true` if the path must not be prefixed.
3. The routes array is imported in `src/index.ts` and registered by the runtime.

### Add a new capability to the connector
1. Open `src/runtime-service.ts` → `WhatsAppConnectorService.registerSendHandlers`.
2. Add the capability string to the `capabilities` array in the `registerMessageConnectorIfAvailable` call.
3. Implement the handler method on `WhatsAppConnectorService` and wire it into the registration object.

### Add a new service
1. Extend `Service` from `@elizaos/core` in a new `src/` file.
2. Import the class in `src/index.ts` and add it to `whatsappPlugin.services`.

## Conventions / Gotchas

- **Transport detection:** `WHATSAPP_AUTH_METHOD` (`cloudapi` / `baileys`) wins when set. Otherwise `WHATSAPP_AUTH_DIR` present → Baileys; `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` present → Cloud API. Baileys takes precedence when both are set (see `resolveRuntimeConfig` in `runtime-service.ts`, transport resolution in `accounts.ts`).
- **Auto-reply is off by default.** Inbound messages are stored in memory. The agent only replies when `WHATSAPP_AUTO_REPLY=true` or when the connector is triggered through the message connector protocol (e.g., a workflow or orchestrator sends on `source: "whatsapp"`).
- **Webhook security:** Cloud API webhook POSTs are rejected without a valid `X-Hub-Signature-256` (uses `WHATSAPP_APP_SECRET`). The GET verification route is public by design (Meta requires it).
- **Bundle safety:** `src/index.ts` contains a large `__bundle_safety_*` array that force-binds re-exported names into the module init. Do not remove it — Bun's tree-shaker collapses re-exports into empty inits on mobile without it.
- **External deps:** `@whiskeysockets/baileys` (Baileys WS), `qrcode` / `qrcode-terminal` (QR display), `pino` (Baileys logger). All are runtime deps. No native binaries.
- **Text chunking:** Outbound text is split into chunks of ≤4096 chars by default (`WHATSAPP_TEXT_CHUNK_LIMIT` constant in `src/normalize.ts`). Groups can override `chunkMode` to `"newline"`.
- **Pairing session limit:** Maximum 10 concurrent Baileys QR pairing sessions (`MAX_PAIRING_SESSIONS` in `setup-routes.ts`).
- For repo-wide architecture rules, logger conventions, and ESM requirements see the root `AGENTS.md`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
