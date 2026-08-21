# @elizaos/plugin-google-workspace

Google Workspace integration for Gmail, Calendar, Drive, Meet, and People (Contacts) with account-scoped OAuth, plus the Google Chat messaging connector (service-account auth) and Google-owned assistant message projections.

## Purpose / role

Adds `GoogleWorkspaceService` to an Eliza agent runtime, exposing Gmail, Google Calendar, Google Drive, Google Meet, and Google People (Contacts) operations through a single account-scoped OAuth grant. It also exports `GoogleGmailAdapter`, the Gmail-owned message-triage adapter used by assistant plugins such as LifeOps. The plugin is opt-in — load it as `googlePlugin` from this package. It also registers with `ConnectorAccountManager` so the generic connector HTTP routes can manage Google accounts and run OAuth flows automatically; that provider registration also mounts the Gmail send `MessageConnector` (`source: "gmail"`, aliases `email`/`mail`) so `MESSAGE op=send` can compose and send email through the connected account.

Google Chat lives here too, as the `src/chat/` module: `GoogleChatService` (service type `"google-chat"`) registers a runtime `MessageConnector` for spaces, DMs, threads, reactions, and attachments. Chat authenticates with a service account (scope `https://www.googleapis.com/auth/chat.bot`), NOT the consolidated Workspace OAuth grant — the two auth models are intentionally separate even though they share this package. The plugin auto-enables when a `connectors.googlechat` block is present and not explicitly disabled (`auto-enable.ts`); the Workspace OAuth side stays opt-in.

## Plugin surface

The plugin object (`googlePlugin`, service name `"google"`) registers:

- **Services:** `GoogleWorkspaceService` — wraps five sub-clients (Gmail, Calendar, Drive, Meet, People), retrieved via `runtime.getService("google")`; `GoogleChatService` — the Chat connector, retrieved via `runtime.getService("google-chat")`.
- **Message adapters:** `GoogleGmailAdapter` — Gmail projection into the core message-triage shape for assistant plugins (thread replies and new outbound email).
- **Message connectors:** the Gmail send connector from `gmail-message-connector.ts`, registered through the Google connector-account provider — routes `MESSAGE op=send source=gmail` / email-literal targets to `GoogleWorkspaceService.sendGmailMessage`.
- **Actions:** none (empty array).
- **Providers:** none (registered separately via `ConnectorAccountManager` at init time).
- **Events:** none.

### `GoogleWorkspaceService` methods

Gmail (`src/gmail.ts` via `GoogleGmailClient`):
- `searchMessages` / `getMessage` / `sendEmail` — basic message read/send.
- `listGmailTriageMessages` / `searchGmailMessages` / `getGmailMessage` / `getGmailMessageDetail` — enriched message fetch with triage scoring.
- `listGmailUnrespondedThreads` — threads needing a reply.
- `modifyGmailMessages` / `modifyGmailMessageLabels` / `trashGmailThread` — label/state mutation.
- `sendGmailReply` / `sendGmailMessage` — outbound send.
- `getGmailSubscriptionHeaders` — subscription/list message headers.
- `createGmailFilterForSender` / `sendMailtoUnsubscribeEmail` — filter and unsubscribe helpers.

Calendar (`src/calendar.ts` via `GoogleCalendarClient`):
- `listCalendars` / `listEvents` / `getEvent` — read.
- `createEvent` / `updateEvent` / `deleteEvent` — write; `createEvent` accepts `createMeetLink: true` to attach a Meet link.

Drive (`src/drive.ts` via `GoogleDriveClient`):
- `searchFiles` / `getFile` / `listDriveFiles` / `searchDriveFiles` — file discovery.
- `getDocContent` / `getSheetContent` — read Docs and Sheets content as plain text/rows.
- `createDriveFile` / `appendToDoc` / `updateSheetCells` — write.

Meet (`src/meet.ts` via `GoogleMeetClient`):
- `createMeeting` / `getMeeting` / `getMeetingSpace` — space management.
- `getConferenceRecord` / `listMeetingParticipants` / `listMeetingParticipantSessions` / `listMeetingTranscripts` / `getMeetingTranscript` / `listMeetingRecordings` / `getMeetingRecordingUrl` — conference artifacts.
- `endMeeting` — ends an active conference.

People (`src/people.ts` via `GooglePeopleClient`, capability `people.read`):
- `listContacts` — page-based saved-contact listing (opaque `nextPageToken` replay, Drive-style).
- `searchContacts` — dual-source search over saved contacts and interaction-derived Other Contacts, with the documented empty-query warmup request; `includeOtherContacts: false` limits to saved contacts.
- `getContact` — fetch one saved contact by its canonical `people/…` resource name. Other Contacts are searchable/listable only; Google's API has no `otherContacts.get` endpoint.
- `generateReport` — builds a structured `GoogleMeetReport` from transcript + recording artifacts and includes a canonical `elizaos.meeting_artifact.v1` artifact.
- `buildGoogleMeetCanonicalArtifact` / `classifyGoogleMeetImportError` — deterministic fixture helpers for saved Google API responses, Google Docs transcript mismatch warnings, missing-artifact classifications, and bot-free capture mapping.

OAuth helpers (`src/auth.ts`):
- `getGoogleOAuthProviderMetadata()` / `getGoogleOAuthProviderConfig(capabilities)` — returns the OAuth provider metadata and a capability-scoped config for the connector manager.
- `MissingGoogleCredentialResolver` — throws a descriptive error; used as the default when no resolver is injected.

## Layout

```
src/
  index.ts                     Plugin entry; exports everything, registers provider at init
  types.ts                     All interfaces and DTOs (GoogleAccountRef, service interfaces, DTOs)
  scopes.ts                    GoogleCapability type, scope derivation, GOOGLE_CAPABILITY_METADATA
  auth.ts                      OAuth provider metadata, getGoogleOAuthProviderConfig, MissingGoogleCredentialResolver
  client-factory.ts            GoogleApiClientFactory — resolves auth and builds googleapis clients
  credential-resolver.ts       DefaultGoogleCredentialResolver — reads tokens from ConnectorAccountStorage/vault
  connector-account-provider.ts  createGoogleConnectorAccountProvider — PKCE OAuth flow, account upsert
  connector-credential-refs.ts   Credential ref persistence helpers (persistConnectorCredentialRefs)
  service.ts                   GoogleWorkspaceService — assembles the four sub-clients
  gmail.ts                     GoogleGmailClient — all Gmail operations
  gmail-message-connector.ts   Gmail send MessageConnector (MESSAGE op=send source=gmail)
  lifeops-message-adapter.ts   GoogleGmailAdapter for assistant/LifeOps message triage registration
  calendar.ts                  GoogleCalendarClient — Calendar list/CRUD
  drive.ts                     GoogleDriveClient — Drive/Docs/Sheets operations
  meet.ts                      GoogleMeetClient — Meet space/conference/artifact operations
  people.ts                    GooglePeopleClient — Contacts/Other Contacts list, search, get
  chat/                        Google Chat connector (service-account auth, MessageConnector)
    service.ts                 GoogleChatService — Chat REST client, webhook processing, multi-account
    accounts.ts                Multi-account config resolution, env var parsing
    connector-account-provider.ts  ConnectorAccountManager adapter for Chat accounts
    config.ts                  GoogleChatConfig / account / space config types
    types.ts                   Chat interfaces, enums, error classes, message chunking
auto-enable.ts                 shouldEnable() — auto-enable on connectors.googlechat
```

## Meet Artifact Contract

The Google Meet import path maps native Meet conference records, participants,
participant sessions, transcript artifacts/entries, Google Docs transcript text,
recordings, and optional bot-free capture artifacts into
`GoogleMeetCanonicalArtifact` (`schemaVersion: "elizaos.meeting_artifact.v1"`).
The canonical artifact preserves streams, participants, participant sessions,
transcript spans, generated summary/key-point/action-item notes, warnings, and
missing-artifact classifications for no transcript, delayed transcript, missing
recording, revoked access, permission denied, meeting not found,
organizer-only artifacts, and expired media URLs. Live sandbox evidence still
requires real Google account access and attaches inline in the PR.

## Commands

```bash
bun run --cwd plugins/plugin-google-workspace build          # compile to dist/
bun run --cwd plugins/plugin-google-workspace test           # vitest run
bun run --cwd plugins/plugin-google-workspace test:watch     # vitest watch
bun run --cwd plugins/plugin-google-workspace lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-google-workspace lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-google-workspace format         # biome format --write
bun run --cwd plugins/plugin-google-workspace format:check   # biome format (read-only)
bun run --cwd plugins/plugin-google-workspace typecheck      # tsc --noEmit
```

## Config / env vars

All three are read via `runtime.getSetting(key)` at OAuth time. All are required for the OAuth flow to work; absence causes the `startOAuth` handler to throw.

| Var | Required | Description |
|-----|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes (for OAuth) | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes (for OAuth) | Google OAuth 2.0 client secret (sensitive) |
| `GOOGLE_REDIRECT_URI` | Yes (for OAuth) | Redirect URI registered in Google Cloud Console |

Testing only:
| Var | Required | Description |
|-----|----------|-------------|
| `ELIZA_MOCK_GOOGLE_BASE` | No | Override googleapis root URL for local mock servers |

Google Chat (service-account auth; see `src/chat/accounts.ts` for full resolution order — per-account character config > `character.settings.googleChat` > `GOOGLE_CHAT_ACCOUNTS` JSON > single-account env vars):

| Var | Required | Description |
|-----|----------|-------------|
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | One of three | Inline service-account JSON |
| `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` | One of three | Path to service-account key file |
| `GOOGLE_APPLICATION_CREDENTIALS` | One of three | ADC credentials path (standard Google env var) |
| `GOOGLE_CHAT_AUDIENCE` | Yes | Audience for webhook token verification (startup throws without it) |
| `GOOGLE_CHAT_AUDIENCE_TYPE` | Yes | `"app-url"` or `"project-number"` (default `"app-url"`) |
| `GOOGLE_CHAT_WEBHOOK_PATH` | No | Webhook path (default `/googlechat`); the host runtime mounts it |
| `GOOGLE_CHAT_SPACES` / `GOOGLE_CHAT_REQUIRE_MENTION` / `GOOGLE_CHAT_BOT_USER` / `GOOGLE_CHAT_ENABLED` / `GOOGLE_CHAT_ACCOUNTS` / `GOOGLE_CHAT_DEFAULT_ACCOUNT_ID` | No | Space list, mention gating, bot user, master switch, multi-account JSON, active account |

## How to extend

### Add a Gmail action

1. Add the action object in `src/gmail.ts` or a new `src/actions/` file. Follow `@elizaos/core` `Action` shape.
2. Add it to the `actions` array in `googlePlugin` in `src/index.ts`.
3. Export it from `src/index.ts` (add to the `export *` block or a named export).

### Add a new Drive method

1. Add the method to `GoogleDriveClient` in `src/drive.ts`.
2. Add the method signature to `IGoogleDriveService` in `src/types.ts`.
3. Delegate from `GoogleWorkspaceService` in `src/service.ts`.

### Add a new capability/scope

1. Add the capability string to `GOOGLE_CAPABILITIES` in `src/scopes.ts`.
2. Add its scope URL(s) to `GOOGLE_OAUTH_SCOPES` and `GOOGLE_CAPABILITY_SCOPES`.
3. Add its metadata entry to `GOOGLE_CAPABILITY_DETAILS`.
4. Update `GROUP_PURPOSE` in `src/connector-account-provider.ts` if the capability belongs to a new group.

## Conventions / gotchas

- **Every method takes `GoogleAccountRef` (`{ accountId: string }`)** as the first positional field. All API calls are account-scoped; there is no single-account shortcut.
- **Credential resolution is pluggable.** The default `DefaultGoogleCredentialResolver` reads from `ConnectorAccountManager` → `ConnectorAccountStorage` → vault. For tests, inject a custom `GoogleCredentialResolver` via `GoogleWorkspaceService` constructor options or `service.setCredentialResolver(...)`.
- **Single consolidated OAuth grant.** All capabilities (Gmail, Calendar, Drive, Meet, People) share one OAuth token per account. Callers may pass a subset of capabilities to `startOAuth` to limit the requested scopes.
- **No actions or providers are registered by default.** Callers that need agent-facing actions must implement them separately and call `GoogleWorkspaceService` methods directly.
- **Node-only.** `package.json` declares `"runtime": "node"`. This plugin uses `node:crypto` and `googleapis` (Node SDK); it will not run in browser or edge environments.
- **googleapis clients are created per-call.** `GoogleApiClientFactory` creates a new googleapis client each call (auth client is cached by credential version in `DefaultGoogleCredentialResolver`).
- **Chat and Workspace auth never mix.** Chat uses service-account credentials and its own webhook audience model; Workspace uses the consolidated per-account OAuth grant. Do not route Chat calls through `GoogleApiClientFactory` or Workspace calls through the Chat account state.
- **Chat messaging routes through the `MessageConnector`** registered by `GoogleChatService` (`source: "google-chat"`); no actions or providers are registered for Chat by design.
- **Chat webhooks:** the plugin does not register an HTTP route; the host runtime delivers events to `GoogleChatService.processWebhookEvent()` on the configured `webhookPath`. Long messages chunk at 4,000 chars on newline/word boundaries (`splitMessageForGoogleChat`).

See the root `CLAUDE.md` for repo-wide architecture rules, logger conventions, and ESM requirements.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
