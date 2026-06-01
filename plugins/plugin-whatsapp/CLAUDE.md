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
- **Text chunking:** Outbound text is split into chunks of ≤4096 chars by default (see `WHATSAPP_TEXT_CHUNK_LIMIT`). Groups can override `chunkMode` to `"newline"`.
- **Pairing session limit:** Maximum 10 concurrent Baileys QR pairing sessions (`MAX_PAIRING_SESSIONS` in `setup-routes.ts`).
- For repo-wide architecture rules, logger conventions, and ESM requirements see the root `AGENTS.md`.
