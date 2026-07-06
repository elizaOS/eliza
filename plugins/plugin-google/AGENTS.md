# @elizaos/plugin-google

Google Workspace integration for Gmail, Calendar, Drive, and Meet with account-scoped OAuth and Google-owned assistant message projections.

## Purpose / role

Adds `GoogleWorkspaceService` to an Eliza agent runtime, exposing Gmail, Google Calendar, Google Drive, and Google Meet operations through a single account-scoped OAuth grant. It also exports `GoogleGmailAdapter`, the Gmail-owned message-triage adapter used by assistant plugins such as LifeOps. The plugin is opt-in — load it as `googlePlugin` from this package. It also registers with `ConnectorAccountManager` so the generic connector HTTP routes can manage Google accounts and run OAuth flows automatically.

Google Chat is out of scope; use `@elizaos/plugin-google-chat` for that.

## Plugin surface

The plugin object (`googlePlugin`, service name `"google"`) registers:

- **Services:** `GoogleWorkspaceService` — the sole runtime service; wraps four sub-clients (Gmail, Calendar, Drive, Meet) and is retrieved via `runtime.getService("google")`.
- **Message adapters:** `GoogleGmailAdapter` — Gmail projection into the core message-triage shape for assistant plugins.
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
  lifeops-message-adapter.ts   GoogleGmailAdapter for assistant/LifeOps message triage registration
  calendar.ts                  GoogleCalendarClient — Calendar list/CRUD
  drive.ts                     GoogleDriveClient — Drive/Docs/Sheets operations
  meet.ts                      GoogleMeetClient — Meet space/conference/artifact operations
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
bun run --cwd plugins/plugin-google build          # compile to dist/
bun run --cwd plugins/plugin-google test           # vitest run
bun run --cwd plugins/plugin-google test:watch     # vitest watch
bun run --cwd plugins/plugin-google lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-google lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-google format         # biome format --write
bun run --cwd plugins/plugin-google format:check   # biome format (read-only)
bun run --cwd plugins/plugin-google typecheck      # tsgo --noEmit
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
- **Single consolidated OAuth grant.** All capabilities (Gmail, Calendar, Drive, Meet) share one OAuth token per account. Callers may pass a subset of capabilities to `startOAuth` to limit the requested scopes.
- **No actions or providers are registered by default.** Callers that need agent-facing actions must implement them separately and call `GoogleWorkspaceService` methods directly.
- **Node-only.** `package.json` declares `"runtime": "node"`. This plugin uses `node:crypto` and `googleapis` (Node SDK); it will not run in browser or edge environments.
- **googleapis clients are created per-call.** `GoogleApiClientFactory` creates a new googleapis client each call (auth client is cached by credential version in `DefaultGoogleCredentialResolver`).

See the root `AGENTS.md` for repo-wide architecture rules, logger conventions, and ESM requirements.

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

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
