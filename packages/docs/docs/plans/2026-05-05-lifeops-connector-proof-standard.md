# LifeOps Connector API Mock Proof Standard

Status: ownership slice for connector/API mock proof standard only.

Source of truth:

- `test/mocks/README.md`
- `test/mocks/helpers/provider-coverage.ts`
- `docs/plans/2026-04-22-gmail-lifeops-integration-review.md`

Related standards:

- [LifeOps Proof Taxonomy](2026-05-05-lifeops-proof-taxonomy.md)
- [LifeOps Account And Credential Matrix](2026-05-05-lifeops-account-credential-matrix.md)
- [LifeOps E2E Proof Requirements](2026-05-05-lifeops-e2e-proof-requirements.md)
- [LifeOps Shared Dependency Ownership Map](2026-05-05-lifeops-shared-ownership-map.md)

This standard copies the Gmail proof bar to every LifeOps connector. A connector
is not considered release-proven because a scenario says it used a channel. It
is proven only when the test can show the exact provider surface, auth contract,
mock-state transition, request ledger entry, real-mode gate, and cleanup path
that would make the same action safe against the real provider.

## Required Proof Shape

Every LifeOps connector scenario that reads or writes provider state must define
these artifacts before it can count as product coverage:

1. Exact provider surface.
   Name the provider API, protocol, bridge, or dependency seam that production
   code actually calls. For HTTP connectors, include method and path patterns.
   For non-HTTP connectors, name the injected client or browser-workspace
   operation and explain why an HTTP mock would not match production.
2. OAuth, API key, bot token, session, or local-bridge scope.
   List the minimum read scopes, write scopes, webhook secrets, account IDs, and
   env vars needed by the scenario. Read-only scenarios must not receive write
   credentials by default.
3. Webhook payload and signature contract.
   For inbound connectors, document the event payload shape, provider signature
   header or verification token, dedupe key, timestamp tolerance, retry behavior,
   and the LifeOps route that accepts it. If the current mock lacks signature
   validation, the scenario must mark that as a gap.
4. Mockoon plus stateful mock behavior.
   The Mockoon JSON file remains the editable fixture source where one exists.
   The in-process `startMocks` runner supplies stateful behavior when static JSON
   cannot prove state transitions, request-body validation, pagination, history,
   auth-scope checks, or test-only inspection routes.
5. Request ledger assertions.
   Every external read or write that matters to the scenario must be asserted
   through `requestLedger()` or `GET /__mock/requests`. Writes must assert
   method, path, account/grant identity, decoded body metadata, selected target
   IDs, and test run ID where the provider contract can carry one.
6. Real-mode gates.
   Mock mode must be loopback-only. Real mode is read-only unless a scenario is
   explicitly marked write-safe and has a provider-specific allowlist. A real
   write attempted from test mode without an allow flag must fail before any
   provider request leaves the process.
7. Cleanup and sweeper.
   Any real write capability must include a dry-run-first sweeper before it can
   be used in CI or manual smoke. The sweeper needs exact run allowlists, target
   recipient/account allowlists, idempotent cleanup, and a permanent-delete gate
   when deletion is possible.
8. Degraded-mode variants.
   Each connector needs explicit tests for disconnected auth, missing scope,
   invalid credentials, provider downtime, rate limit, malformed response,
   duplicate webhook, stale cursor, and partial write failure when the provider
   supports those states.
9. CI credential expectations.
   CI must run mock mode by default. Live comparison jobs may be read-only with
   disposable test accounts. Real write jobs require opt-in secrets, explicit
   run IDs, isolated provider resources, and post-run sweeper evidence.

## Gmail Baseline To Copy

Gmail is the current model for this standard:

- `ELIZA_MOCK_GOOGLE_BASE` rewrites Google API and OAuth traffic to the local
  mock.
- The mock covers Gmail message list/get/search/send/modify/delete, thread
  list/get/modify/trash/untrash, draft create/list/get/send/delete, attachment
  metadata/download, labels, history, watch, settings filters, and request
  ledger metadata.
- Gmail scenarios assert structured final checks, dynamic target discovery,
  approval-bound writes, no-real-write proof, and request-ledger writes.
- `ELIZA_BLOCK_REAL_GMAIL_WRITES=1` blocks direct real Gmail writes unless the
  request is routed to a loopback mock or `ELIZA_ALLOW_REAL_GMAIL_WRITES=1` is
  intentionally set.
- Real Gmail smoke cleanup is dry-run-first, run-ID allowlisted, recipient
  allowlisted, and swept by exact subject/body run ID through LifeOps, with a
  direct Gmail token fallback that can also use a per-run label/header.

All other connectors should reach this same shape, adjusted to their provider
protocol.

## Connector Matrix

| Connector | Current mock truth | Required provider endpoints or surfaces | Auth, scopes, and env vars | Webhook or inbound contract | Ledger, real-mode gate, cleanup, and CI expectation |
| --- | --- | --- | --- | --- | --- |
| Google Calendar | Covered as `google-calendar`, `stateful-http`, `google` environment. | OAuth token/userinfo rewrite; calendar list; event list/get/search; event create/patch/update/move/delete. Required additions: freebusy, ACL, attachments, conference data, recurring expansion, rate-limit variants. | `ELIZA_MOCK_GOOGLE_BASE`; Google identity scope plus Calendar read scope for reads and Calendar write scope only for create/patch/update/move/delete scenarios. | Calendar push notification proof still needs channel payload, resource ID/state, expiration, channel token, and idempotent sync cursor handling. | Assert all reads/writes in ledger with calendar ID, event ID, mutation body, grant/account ID, and run ID. Mock mode loopback-only. Real writes require disposable calendar, event title/body run ID, calendar allowlist, and sweeper that deletes only matching run events. CI uses mock credentials by default; live jobs read-only until sweeper exists. |
| Gmail | Covered as `gmail`, `stateful-http`, `google` environment. | Message list/get/search/send/modify/delete; batch modify/delete; attachment metadata/download; labels; draft create/list/get/send/delete; thread list/get/modify/trash/untrash; watch/history; settings filters. Required additions: attachment upload, full MIME fidelity, delegated mailboxes, quota/rate-limit variants, push-notification parity. | `ELIZA_MOCK_GOOGLE_BASE`, `ELIZA_BLOCK_REAL_GMAIL_WRITES`; Gmail read scopes by default, `gmail.modify` only for inbox management, send/compose scopes only for confirmed send/draft scenarios. | Gmail watch/history ingestion needs Pub/Sub notification payload, history cursor, dedupe, and no direct route-to-tool execution. | Existing ledger and write guard are baseline. Real writes require explicit allow flag, recipient allowlist, run ID, dry-run sweeper, and no personal mailbox destructive tests. CI mock mode by default; live read-only comparison may use scrubbed snapshots. |
| Google Drive, Docs, Sheets | Not in current provider coverage table; no central mock documented in `test/mocks/README.md`. | Must add Drive file list/get/search/export/download/create/update/permission surfaces as used by LifeOps. Docs proof must cover document get/batchUpdate/export. Sheets proof must cover spreadsheet get/values get/update/batchUpdate. | Expected Google OAuth rewrite should reuse `ELIZA_MOCK_GOOGLE_BASE`, but Drive/Docs/Sheets scopes must be separate from Gmail/Calendar and granted only per scenario. | Drive push notification proof needs channel payload, resource ID/state, file ID, change token, and idempotent change processing. | Coverage cannot count until stateful mocks and ledger assertions exist. Real writes require disposable folder/doc/sheet allowlists, run-ID naming, permission sweeper, and no owner Drive destructive tests. CI should run mock-only until fixture export/scrub and sweeper exist. |
| Discord | Covered as `discord`, `browser-workspace`, `browser-workspace` environment. | Browser workspace tab lifecycle; navigation; script evaluation; LifeOps outbound send via browser workspace eval; snapshot. No Discord REST or Gateway mock is current truth. | `ELIZA_BROWSER_WORKSPACE_URL`, `ELIZA_BROWSER_WORKSPACE_TOKEN`, `ELIZA_DISABLE_DISCORD_DESKTOP_CDP`. Real desktop/session credentials must be outside CI. | Current mock is workspace-level, not provider webhook/Gateway-level. Inbound proof must define DOM snapshot or Gateway event fixture, message ID/channel ID/guild ID, timestamp, dedupe, and layout-compatibility assertions. | Assert workspace requests in ledger, including tab ID, eval command category, channel target, and outbound text hash. Real mode requires a test Discord server/channel allowlist and cleanup/delete proof if messages are sent. CI uses browser-workspace mock only. |
| Telegram | Covered as `telegram`, `dependency-seam`; intentionally no HTTP Mockoon environment. | MTProto local-client dependency injection through `telegram-local-client.ts` and `TelegramLocalClientDeps`; local mock session; auth retry; service status; send/search/read-receipt calls. | No mock env vars. Real mode needs Telegram session/API credentials kept out of default CI and scoped to a test account. | Inbound proof should use the dependency seam event shape, message ID/chat ID/sender ID/date, update ordering, dedupe, and media omission behavior. Do not add an HTTP facade unless production uses one. | Assert calls through injected deps and scenario-level operation log. Real sends require test chat allowlist, run-ID message text, and cleanup/delete or tombstone proof. CI uses dependency seam only. |
| Signal | Covered as `signal`, `stateful-http`, `signal` environment. | `signal-cli` health check; REST receive; REST send; JSON-RPC send; simulator read path backed by receive. Required additions: attachments, groups, profile, registration, safety numbers, daemon restart, backfill, malformed envelopes. | `SIGNAL_HTTP_URL`, `SIGNAL_ACCOUNT_NUMBER`. Real mode needs an isolated Signal account/device and no default CI secrets. | Receive contract must cover envelope/source/timestamp/message body, attachment metadata when added, receive queue consumption risk, dedupe, and malformed envelope variants. | Assert health, receive, send, and JSON-RPC requests in ledger with account number, recipient, body hash, and run ID. Real sends require recipient allowlist and sweeper or manual verification plan; live snapshots must skip destructive pulls unless explicitly allowed. |
| iMessage / BlueBubbles | Covered as `imessage-bluebubbles`, `stateful-http`, `bluebubbles` environment. | Server info; chat query; message query/search; text send; message detail/delivery metadata. Required additions: attachments, tapbacks/reactions, edit, unsend, read receipts, macOS Messages DB fallback. | `ELIZA_IMESSAGE_BACKEND`, `ELIZA_BLUEBUBBLES_URL`, `BLUEBUBBLES_SERVER_URL`, `ELIZA_BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_PASSWORD`. | Inbound proof needs BlueBubbles webhook payload, chat GUID, message GUID, sender handle, timestamp, password/signature verification, dedupe, and delivery retry behavior. | Assert ledger for chat lookup, send, and message detail with chat GUID, recipient handle hash, body hash, and run ID. Real sends require a dedicated test chat/contact, run-ID body, and cleanup/visibility policy because iMessage deletion semantics are limited. CI uses mock only. |
| WhatsApp | Covered as `whatsapp`, `stateful-http`, `whatsapp` environment. | Text message send; inbound webhook ingestion at `/webhook` and `/webhooks/whatsapp`; Cloud API webhook metadata/contact mapping; test-only inbound buffer. Required additions: media, templates, reactions, statuses, delivery lifecycle, webhook signature validation, retry simulation. | `ELIZA_MOCK_WHATSAPP_BASE`; real mode needs WhatsApp Business test number, access token, phone number ID, app secret, and verify token. | Webhook proof must cover Meta verify challenge, `X-Hub-Signature-256`, message payload, contact mapping, status payload, dedupe by message ID, retry/timestamp behavior, and invalid-signature rejection. | Assert send and inbound buffer ledger with phone number ID, recipient hash, message ID, body hash, and run ID. Real sends require recipient allowlist, template/test-number constraints, run-ID text, and cleanup/audit note because sent WhatsApp messages may not be erasable. CI mock-only by default. |
| Twilio SMS / Voice | Covered as `twilio`, `static-http`, `twilio` environment. | Programmable Messaging send; Programmable Voice call create; Mockoon request echo. Required additions: delivery callbacks, recordings, media, incoming call webhooks, inbound SMS, error variants. | `ELIZA_MOCK_TWILIO_BASE`; real mode needs account SID, auth token/API key, from number, recipient allowlist, voice URL/status callback URLs. | Inbound SMS and voice proof must cover Twilio form payload, `X-Twilio-Signature`, message/call SID, from/to, timestamp or replay guard where available, dedupe, and status callback lifecycle. | Static response is not enough for destructive proof. Add stateful ledger assertions for outbound SMS/calls and callbacks. Real sends/calls require test numbers, exact run ID in body/twiml/status metadata, billing guard, and sweeper/audit for created messages/calls. CI mock-only unless Twilio test credentials are explicitly enabled. |
| X DM | Covered as `x`, `stateful-http`, `x-twitter` environment. | Home timeline; mentions; recent search; DM list; tweet create; DM send. Required additions: streaming API, OAuth handshake, media upload, delete/like/repost, rate-limit, protected-account variants. | `ELIZA_MOCK_X_BASE`; real mode needs OAuth user context with read/write/DM permissions scoped to a test account. | DM/inbound proof needs event ID, conversation ID, sender/recipient IDs, timestamp, dedupe, pagination cursor, and deleted/protected-account variants. | Assert timeline/search/DM/send ledger with user ID, conversation ID, text hash, and run ID. Real writes require test account and recipient allowlists, no public tweets unless explicitly allowed, run-ID text, and delete/sweeper where provider allows. CI mock-only by default. |
| Calendly | Covered as `calendly`, `static-http`, `calendly` environment. | Current user; event types; available times; scheduling links; scheduled events. Required additions: webhooks, invitee cancellation/reschedule, org/team scopes, OAuth refresh variants. | `ELIZA_MOCK_CALENDLY_BASE`; real mode needs read-only token by default, scheduling/write credentials only for disposable event types. | Webhook proof must cover invitee.created/invitee.canceled payloads, event UUID, invitee UUID, signing key/header if configured, dedupe, and retry behavior. | Static fixtures prove reads only. Writes/scheduling need stateful mock assertions for link/event creation and invitee state. Real scheduling requires disposable event type, run-ID invitee/name/email, cancellation sweeper, and no real customer calendars. CI mock-only until stateful scheduling and sweeper exist. |
| Browser Portal | Covered indirectly by `browser-workspace` environment for Discord browser operations. | `/tabs`, `/tabs/:id/navigate`, `/tabs/:id/eval`, `/tabs/:id/show`, `/tabs/:id/hide`, `/tabs/:id/snapshot`, close. If Browser Portal is a distinct product surface, it needs its own provider ID. | `ELIZA_BROWSER_WORKSPACE_URL`, `ELIZA_BROWSER_WORKSPACE_TOKEN`; disable real desktop CDP in CI. | Inbound events are not currently defined. Any portal callback must define session ID, tab ID, origin, user-visible action, signature/token, and replay protection. | Assert every navigation/eval/snapshot in ledger and forbid non-loopback browser workspace URLs in tests. Real mode requires isolated browser profile and no credential-bearing production pages in CI. Cleanup closes tabs and clears profile state. |
| Notifications | Not in current provider coverage table; no central mock documented. | Must define actual provider: APNs, FCM, Web Push, OS notification center, or internal LifeOps notification API. Required surfaces include send, schedule, cancel, status, and user-action callback if supported. | Auth depends on provider and must be documented before tests count: APNs key/topic, FCM server credentials, VAPID keys, or internal token. | Callback proof needs notification ID, action ID, user/device ID, timestamp, signature/token, dedupe, and replay behavior. | No coverage should be claimed until a provider-specific mock, ledger, and cleanup exist. Real notifications require test device/user allowlists, run-ID payload, opt-in secrets, and post-run cancel/audit evidence. CI should use mock provider only. |
| Travel | Not in current provider coverage table; no central mock documented. | Must define concrete providers before proof: airline, hotel, maps, rideshare, booking email parser, or travel API. Required surfaces vary but must include search/read itinerary plus any booking/cancel/change writes separately. | Provider credentials and scopes must be per-provider. Booking/write credentials are never default CI credentials. | Inbound proof may be webhook, email ingestion, or polling. It must define itinerary/confirmation IDs, traveler identity, timestamp, signature or provenance, dedupe, and cancellation/change lifecycle. | No release coverage until the exact provider mocks and ledgers exist. Real booking/change/cancel flows require sandbox providers or human-in-the-loop dry-run only, strict spend guard, run-ID metadata, and cleanup/cancel proof. |
| GitHub | Covered as `github`, `stateful-http`, `github` environment. | REST PR list/review; issue creation/assignment; issue/PR search; notifications; Octokit-shaped fixture. Required additions: GraphQL, checks/statuses, contents, branch protection, workflow endpoints, webhooks. | `ELIZA_MOCK_GITHUB_BASE`, `GITHUB_API_URL`; real mode needs token scopes minimized to read-only unless issue/PR mutation scenario is explicitly write-safe. | Webhook proof needs event type, delivery ID, signature `X-Hub-Signature-256`, installation/repository IDs, action, dedupe, and retry behavior. | Assert REST and Octokit fixture calls in ledger with repo, issue/PR number, mutation body, and run ID. Real writes require test repository allowlist, run-ID issue/PR labels/body, cleanup close/delete where possible, and no owner production repo mutation in CI. |
| n8n | Partially referenced by Gmail event workflow plans, but no provider coverage entry or central mock environment is current truth. | Must define workflow dispatch endpoint, execution status endpoint, credential boundary, and callback/webhook route if LifeOps waits for n8n results. | Required env vars and signing secret must be documented before use. Real mode should use a disposable workflow or n8n test project. | Dispatch/callback proof needs workflow ID, execution ID, event type, signed payload, timestamp tolerance, dedupe key, retry behavior, and no direct webhook-to-tool execution. | Add stateful mock for dispatch and execution status before counting n8n proof. Ledger must assert event payload, workflow ID, execution ID, and run ID. Real runs require disabled side effects or disposable credentials, dry-run workflow, execution cleanup/audit, and CI opt-in secrets only. |

## Minimum Degraded-Mode Matrix

Each connector should have at least these negative or degraded variants:

| Variant | Required proof |
| --- | --- |
| Disconnected | Assistant reports connector is disconnected and no provider request is sent. |
| Missing scope | Provider or connector returns an actionable missing-scope state; writes do not downgrade into silent reads or drafts. |
| Invalid credential | Auth failure is surfaced with reconnect guidance; no retry storm. |
| Provider down | Timeout/5xx produces degraded response and records retry/backoff state when applicable. |
| Rate limited | 429 or provider quota response produces retry-after handling and no duplicate writes. |
| Duplicate inbound event | Dedupe key prevents double memory/task/message creation. |
| Stale cursor | Connector backfill resumes safely or asks for reconnect/resync without data loss. |
| Partial write failure | User-visible result reports exactly which targets succeeded, failed, or were skipped. |
| Too-broad destructive request | Assistant refuses or narrows before any provider write ledger entry appears. |

## Request Ledger Assertions

For every connector, scenario final checks should assert:

- provider ID and mock environment or dependency seam
- HTTP method/path or non-HTTP operation name
- account, grant, channel, chat, repo, calendar, or workflow identity
- selected target IDs discovered by a prior read, not hardcoded final checks
- decoded write body metadata with sensitive values redacted or hashed
- run ID, scenario ID, and approval ID where applicable
- absence of real network requests in mock mode
- absence of write ledger entries for refusal, missing-scope, disconnected, or
  stale-confirmation scenarios

## Real-Mode Credential Policy

CI defaults to mock mode for all connectors. Live jobs may be added only after
the connector has:

- an isolated provider test account/resource
- read-only default credentials
- explicit write opt-in secret names
- allowlisted recipients/resources
- a provider-specific dry-run sweeper
- run-ID metadata that the provider can preserve
- audit output committed as CI artifact, not provider data committed as fixture

Real owner data must not be committed. Any fixture export path must scrub
emails, phone numbers, handles, account IDs, message IDs, thread IDs, file IDs,
calendar IDs, repo names when private, raw tokens, signatures, and long provider
identifiers before the fixture enters `test/mocks` or scenario files.

## Ownership Notes

The current executable coverage registry remains
`test/mocks/helpers/provider-coverage.ts`. This document sets the proof bar for
all requested LifeOps connectors, including connectors that do not yet have
central mocks. New connector coverage should update that registry, the Mockoon
README, the relevant mock environment, stateful runner behavior, and provider
coverage contract tests in the same implementation slice.
