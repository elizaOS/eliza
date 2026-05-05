# LifeOps account and credential matrix

Date: 2026-05-05

Related standards:

- [LifeOps Proof Taxonomy](2026-05-05-lifeops-proof-taxonomy.md)
- [LifeOps Connector API Mock Proof Standard](2026-05-05-lifeops-connector-proof-standard.md)
- [LifeOps E2E Proof Requirements](2026-05-05-lifeops-e2e-proof-requirements.md)
- [LifeOps Shared Dependency Ownership Map](2026-05-05-lifeops-shared-ownership-map.md)

Purpose: turn the LifeOps live-credential gap into a concrete provisioning checklist. This is not an implementation plan; it is the account, permission, secret, smoke-test, and safety-gate inventory required before live connector claims can graduate from mock coverage to release evidence.

Principles:

- Use dedicated test tenants, mailboxes, phone numbers, calendars, repos, channels, and devices. Do not use the owner's production accounts for CI.
- Split read and write credentials where the provider allows it.
- Default CI to read-only smoke. Write smoke must require an explicit `LIFEOPS_LIVE_WRITE_ENABLED=1` gate plus provider-specific allowlists.
- Every live write must be idempotent or tagged for cleanup.
- Every webhook receiver must verify signatures or shared secrets before processing.
- Missing credentials must produce an explicit skip reason in local runs and a hard failure in the live-credential CI lane unless the connector is intentionally disabled.

## Global CI gates and conventions

| Field | Standard |
| --- | --- |
| Live test master switch | `LIFEOPS_LIVE_E2E=1` |
| Live write master switch | `LIFEOPS_LIVE_WRITE_ENABLED=1` |
| Provider selector | `LIFEOPS_LIVE_PROVIDERS=google,discord,...` or per-provider `LIFEOPS_<PROVIDER>_ENABLED=1` |
| Test run tag | `LIFEOPS_TEST_RUN_ID=<uuid-or-ci-run-id>` |
| Allowed recipients | `LIFEOPS_TEST_ALLOWED_EMAILS`, `LIFEOPS_TEST_ALLOWED_PHONES`, `LIFEOPS_TEST_ALLOWED_CHAT_IDS`, `LIFEOPS_TEST_ALLOWED_REPOS` |
| Public callback base | `LIFEOPS_PUBLIC_BASE_URL=https://lifeops-live.example.test` |
| Webhook verifier | Reject unsigned callbacks, wrong shared secret, wrong token, wrong tenant/account, stale timestamp, replayed delivery ID |
| Cleanup expectation | Each write smoke creates artifacts tagged with `lifeops-test`, `LIFEOPS_TEST_RUN_ID`, or a provider-native test label and runs a sweeper at suite end |
| Failure policy | Fail on credential-gated skip in live CI; allow explicit local skip with `SKIP_REASON` following `test/vitest/fail-on-silent-skip.setup.ts`; `LIFEOPS_LIVE_SKIP_REASON` may be mirrored in custom scripts but should not replace `SKIP_REASON` in Vitest lanes |

## Google: Gmail, Calendar, Drive

| Field | Matrix |
| --- | --- |
| Required account type | Google Cloud project with OAuth consent screen; dedicated Google Workspace or Gmail test users; domain-wide delegation only if enterprise admin flows are intentionally tested. |
| OAuth scopes/API permissions | Gmail read: `https://www.googleapis.com/auth/gmail.readonly`; Gmail modify/write: `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.send` only where needed; Calendar read/write: `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/calendar.events`; Drive read/write: `https://www.googleapis.com/auth/drive.metadata.readonly`, `https://www.googleapis.com/auth/drive.readonly`, and narrow `https://www.googleapis.com/auth/drive.file` for app-created files. Avoid all-mail `https://mail.google.com/` unless a test explicitly needs full mailbox control. |
| Env vars/secrets | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_TEST_GRANT_JSON`, `GOOGLE_TEST_USER_EMAIL`, `GOOGLE_TEST_WORKSPACE_DOMAIN`; optional `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DELEGATED_USER_EMAIL`. |
| Webhook/public URL setup | Gmail push requires Pub/Sub topic/subscription and `gmail.users.watch`; Calendar push channels require a public HTTPS receiver and per-channel token; Drive changes watch requires public receiver and channel lifecycle storage. |
| Sandbox/test account requirements | At least two test users: owner and correspondent. Seed mailbox labels, one test calendar, one shared calendar, and one Drive folder owned by the test user. OAuth app may remain testing-mode if CI users are listed as test users. |
| Mock env var equivalent | Current: `ELIZA_MOCK_GOOGLE_BASE` for Gmail/Calendar/OAuth rewrite. Future Drive/Docs/Sheets mocks should reuse `ELIZA_MOCK_GOOGLE_BASE` unless a separate Google mock split is introduced. |
| Live read smoke | List authenticated profile, search Gmail for a seeded label, list calendars, read next 10 events from the test calendar, list files in the LifeOps test Drive folder. |
| Live write smoke | Create a draft only, send only to `GOOGLE_TEST_ALLOWED_RECIPIENT`, add/remove a test Gmail label, create/update/delete one event in `LifeOps Test Calendar`, create/update/trash one file in `LifeOps Test Drive Folder`. |
| Cleanup/sweeper | Delete drafts created by run ID, remove labels, delete test events by `extendedProperties.private.lifeopsRunId`, trash Drive files with app property or filename prefix. Stop webhook channels on teardown. |
| CI secret names/placeholders | `LIFEOPS_GOOGLE_OAUTH_CLIENT_ID`, `LIFEOPS_GOOGLE_OAUTH_CLIENT_SECRET`, `LIFEOPS_GOOGLE_REFRESH_TOKEN_READONLY`, `LIFEOPS_GOOGLE_REFRESH_TOKEN_WRITE`, `LIFEOPS_GOOGLE_PUBSUB_TOPIC`, `LIFEOPS_GOOGLE_PUBSUB_SUBSCRIPTION`. |
| Safety gates | Write path requires selected `grantId`, account email match, allowlisted recipients/domains, bounded batch count, confirmation/audit record, no cross-account writes, and no full-mail scope in default CI. |

## Discord

| Field | Matrix |
| --- | --- |
| Required account type | Discord developer application with bot user; dedicated test guild controlled by the project. |
| OAuth scopes/API permissions | Install with `bot` and `applications.commands`; user OAuth only if reading user identity is needed (`identify`, optional `guilds`). Bot permissions should be narrow: send messages, read message history, use slash commands, manage webhooks only if webhook testing is required. |
| Env vars/secrets | `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_TEST_GUILD_ID`, `DISCORD_TEST_CHANNEL_ID`, `DISCORD_WEBHOOK_URL` if using channel webhooks. |
| Webhook/public URL setup | Interactions endpoint must be public HTTPS and verify Discord request signatures with `DISCORD_PUBLIC_KEY`. Gateway mode needs no public URL but must handle reconnect/rate limits. |
| Sandbox/test account requirements | One private test guild, bot installed only there, one read channel, one write channel, seeded test messages. |
| Mock env var equivalent | Current: `ELIZA_BROWSER_WORKSPACE_URL`, `ELIZA_BROWSER_WORKSPACE_TOKEN`, `ELIZA_DISABLE_DISCORD_DESKTOP_CDP=1` through the browser-workspace mock. No Discord REST/Gateway mock exists yet. |
| Live read smoke | Fetch current bot application/guild identity, read recent messages from the test channel, verify slash command registration. |
| Live write smoke | Send one message to the write channel with run ID, optionally edit then delete it. |
| Cleanup/sweeper | Delete bot messages matching run ID; remove test webhooks and temporary slash commands created by CI. |
| CI secret names/placeholders | `LIFEOPS_DISCORD_BOT_TOKEN`, `LIFEOPS_DISCORD_APPLICATION_ID`, `LIFEOPS_DISCORD_PUBLIC_KEY`, `LIFEOPS_DISCORD_TEST_GUILD_ID`, `LIFEOPS_DISCORD_TEST_CHANNEL_ID`. |
| Safety gates | Writes limited to test guild/channel; reject DMs in CI; require message prefix `lifeops-test`; enforce Discord rate-limit backoff. |

## Telegram

| Field | Matrix |
| --- | --- |
| Required account type | Telegram bot created through BotFather; dedicated private test chat/group. |
| OAuth scopes/API permissions | No OAuth scopes. Bot token grants Bot API access. Group privacy mode must match the test plan. |
| Env vars/secrets | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `TELEGRAM_TEST_CHAT_ID`, `TELEGRAM_TEST_USER_ID`. |
| Webhook/public URL setup | `setWebhook` to `${LIFEOPS_PUBLIC_BASE_URL}/webhooks/telegram` with secret token; alternatively long polling for local smoke. |
| Sandbox/test account requirements | Private test group or direct chat with the bot; one human test account or seeded update fixture. |
| Mock env var equivalent | Current: no HTTP mock env var. Tests use the Telegram local-client dependency seam and encoded mock session fixtures. |
| Live read smoke | Call `getMe`; receive one `/ping <runId>` update through webhook or polling. |
| Live write smoke | Send one allowlisted message to `TELEGRAM_TEST_CHAT_ID`; optionally edit/delete if supported by message type. |
| Cleanup/sweeper | Delete test messages where possible; clear webhook after CI if using ephemeral public URLs. |
| CI secret names/placeholders | `LIFEOPS_TELEGRAM_BOT_TOKEN`, `LIFEOPS_TELEGRAM_WEBHOOK_SECRET_TOKEN`, `LIFEOPS_TELEGRAM_TEST_CHAT_ID`. |
| Safety gates | Never send outside `TELEGRAM_TEST_CHAT_ID`; verify webhook secret header; forbid broadcast-style loops in CI. |

## Signal

| Field | Matrix |
| --- | --- |
| Required account type | Dedicated Signal phone number registered to `signal-cli` or equivalent local bridge; do not use the owner's personal Signal number. |
| OAuth scopes/API permissions | No OAuth scopes. Access is controlled by phone-number registration, local `signal-cli` profile, and local bridge credentials. |
| Env vars/secrets | `SIGNAL_CLI_RPC_URL`, `SIGNAL_CLI_ACCOUNT`, `SIGNAL_CLI_RPC_TOKEN` if bridge auth is enabled, `SIGNAL_TEST_RECIPIENT`. |
| Webhook/public URL setup | Prefer local JSON-RPC/SSE bridge. Public webhook only if wrapping the bridge behind a signed relay. |
| Sandbox/test account requirements | Two test numbers/devices, one registered sender, one allowlisted recipient. |
| Mock env var equivalent | Current: `SIGNAL_HTTP_URL`, `SIGNAL_ACCOUNT_NUMBER` pointed at `test/mocks/environments/signal.json` through `startMocks`. |
| Live read smoke | Query registered account and receive an allowlisted inbound test message/event from the test recipient. |
| Live write smoke | Send one run-ID-tagged message to `SIGNAL_TEST_RECIPIENT`. |
| Cleanup/sweeper | Signal messages cannot be reliably removed for all recipients; write smoke must use a disposable test thread and mark artifacts in local audit state. |
| CI secret names/placeholders | `LIFEOPS_SIGNAL_CLI_RPC_URL`, `LIFEOPS_SIGNAL_CLI_ACCOUNT`, `LIFEOPS_SIGNAL_CLI_RPC_TOKEN`, `LIFEOPS_SIGNAL_TEST_RECIPIENT`. |
| Safety gates | Local bridge must bind to localhost or private network only; recipient allowlist mandatory; no production contacts loaded into CI. |

## WhatsApp Cloud API

| Field | Matrix |
| --- | --- |
| Required account type | Meta developer app connected to a WhatsApp Business Account; use Meta's test phone number for early CI, then a dedicated business test number for production-like smoke. |
| OAuth scopes/API permissions | `whatsapp_business_messaging`, `whatsapp_business_management`; app may also need `business_management` for some WABA operations. |
| Env vars/secrets | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_TEST_RECIPIENT`. |
| Webhook/public URL setup | Public HTTPS callback subscribed to WhatsApp messages/statuses; verify challenge token on setup and validate `X-Hub-Signature-256` with app secret. |
| Sandbox/test account requirements | Test WABA/phone number, allowlisted recipient phone, approved message template for outbound business-initiated smoke if outside the customer-service window. |
| Mock env var equivalent | Current: `ELIZA_MOCK_WHATSAPP_BASE`. |
| Live read smoke | Verify phone number metadata and receive one inbound webhook from allowlisted test recipient. |
| Live write smoke | Send one approved template or in-window test reply to `WHATSAPP_TEST_RECIPIENT`; verify delivery status webhook if available. |
| Cleanup/sweeper | Cannot delete recipient messages; record run ID and expire local conversation/test state. Remove transient webhook subscriptions if created for CI. |
| CI secret names/placeholders | `LIFEOPS_WHATSAPP_ACCESS_TOKEN`, `LIFEOPS_WHATSAPP_APP_SECRET`, `LIFEOPS_WHATSAPP_VERIFY_TOKEN`, `LIFEOPS_WHATSAPP_PHONE_NUMBER_ID`, `LIFEOPS_WHATSAPP_WABA_ID`, `LIFEOPS_WHATSAPP_TEST_RECIPIENT`. |
| Safety gates | Template-only writes unless inbound test message opened a service window; recipient allowlist; app-secret signature verification; opt-out keyword handling tested before any broader use. |

## Twilio SMS and Voice

| Field | Matrix |
| --- | --- |
| Required account type | Twilio project/subaccount with a dedicated test phone number; use restricted API keys where available. |
| OAuth scopes/API permissions | Twilio account SID plus API key/secret or auth token. Restrict to Messaging/Voice resources and test subaccount when possible. |
| Env vars/secrets | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_TEST_TO_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_STATUS_CALLBACK_URL`. |
| Webhook/public URL setup | Configure inbound SMS webhook, voice webhook, and message status callback on the number or messaging service; validate `X-Twilio-Signature`. |
| Sandbox/test account requirements | Twilio test credentials for API shape; real verified recipient/owned number for live send/receive; separate number for voice if needed. |
| Mock env var equivalent | Current: `ELIZA_MOCK_TWILIO_BASE`. |
| Live read smoke | Fetch account/number metadata and recent messages/calls for the test number. |
| Live write smoke | Send one SMS to `TWILIO_TEST_TO_NUMBER`; optional voice smoke places a call only to a verified controlled number and uses test TwiML. |
| Cleanup/sweeper | Delete local message/call audit records; Twilio logs remain provider-side. Release rented numbers only in manual teardown, not automated CI. |
| CI secret names/placeholders | `LIFEOPS_TWILIO_ACCOUNT_SID`, `LIFEOPS_TWILIO_API_KEY_SID`, `LIFEOPS_TWILIO_API_KEY_SECRET`, `LIFEOPS_TWILIO_AUTH_TOKEN`, `LIFEOPS_TWILIO_FROM_NUMBER`, `LIFEOPS_TWILIO_TEST_TO_NUMBER`. |
| Safety gates | Recipient allowlist, max one outbound SMS/call per run, STOP/opt-out respect, signature validation, spend cap alert, no emergency-number calls. |

## BlueBubbles / iMessage

| Field | Matrix |
| --- | --- |
| Required account type | Dedicated macOS host signed into a disposable Apple ID/iMessage account; BlueBubbles Server installed. Private API requires local macOS permissions and should be treated as non-App-Store/non-production-risk until explicitly accepted. |
| OAuth scopes/API permissions | No OAuth. BlueBubbles REST API uses server password/token; Private API requires macOS accessibility/full disk/automation style permissions depending on feature. |
| Env vars/secrets | `BLUEBUBBLES_SERVER_URL`, `BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_PRIVATE_API_ENABLED`, `IMESSAGE_TEST_CHAT_GUID`, `IMESSAGE_TEST_RECIPIENT`. |
| Webhook/public URL setup | BlueBubbles webhooks configured to public HTTPS or private tunnel; authenticate callback with shared secret if proxying. |
| Sandbox/test account requirements | Dedicated Mac mini/VM where allowed, disposable Apple ID, test recipient Apple ID/phone, no production Messages database. |
| Mock env var equivalent | Current: `ELIZA_IMESSAGE_BACKEND=bluebubbles`, `ELIZA_BLUEBUBBLES_URL`, `BLUEBUBBLES_SERVER_URL`, `ELIZA_BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_PASSWORD` pointed at the BlueBubbles mock. |
| Live read smoke | Query server health, list chats, read the latest message in the test chat. |
| Live write smoke | Send one run-ID-tagged iMessage to test chat only. |
| Cleanup/sweeper | Deleting iMessages is local and inconsistent across devices; use disposable test chat and local audit cleanup. Rotate BlueBubbles password after shared CI use. |
| CI secret names/placeholders | `LIFEOPS_BLUEBUBBLES_SERVER_URL`, `LIFEOPS_BLUEBUBBLES_PASSWORD`, `LIFEOPS_IMESSAGE_TEST_CHAT_GUID`, `LIFEOPS_IMESSAGE_TEST_RECIPIENT`. |
| Safety gates | Never mount owner's Messages database in CI; allowlisted chat GUID mandatory; no group discovery writes; document Apple ID and macOS automation risk before release. |

## X

| Field | Matrix |
| --- | --- |
| Required account type | X developer project/app with a dedicated test X account and API tier that includes required endpoints. |
| OAuth scopes/API permissions | OAuth 2.0 user context: `tweet.read`, `users.read`; writes need `tweet.write`; DMs need `dm.read`, `dm.write`, and required dependent read scopes. Use offline access only if refresh tokens are required. |
| Env vars/secrets | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `X_REFRESH_TOKEN_READONLY`, `X_REFRESH_TOKEN_WRITE`, `X_BEARER_TOKEN`, `X_TEST_USER_ID`, `X_TEST_RECIPIENT_ID`. |
| Webhook/public URL setup | Account Activity/webhook access depends on product tier; if unavailable, use polling for CI. Public callback must validate CRC/signature when webhook mode is enabled. |
| Sandbox/test account requirements | Dedicated public or protected test account; second allowlisted account for mentions/DMs; no production follower graph in CI. |
| Mock env var equivalent | Current: `ELIZA_MOCK_X_BASE`. |
| Live read smoke | Fetch authenticated user, read own recent posts or mentions, optionally read allowlisted DM thread if permissioned. |
| Live write smoke | Post one test tweet/reply and delete it; optional DM only to `X_TEST_RECIPIENT_ID`. |
| Cleanup/sweeper | Delete tweets created with run ID; expire local tokens if test run rotates grant. |
| CI secret names/placeholders | `LIFEOPS_X_CLIENT_ID`, `LIFEOPS_X_CLIENT_SECRET`, `LIFEOPS_X_REFRESH_TOKEN_READONLY`, `LIFEOPS_X_REFRESH_TOKEN_WRITE`, `LIFEOPS_X_TEST_USER_ID`, `LIFEOPS_X_TEST_RECIPIENT_ID`. |
| Safety gates | Writes disabled unless API tier and account are dedicated; delete-after-write required; no engagement automation beyond explicit test post/DM. |

## Calendly

| Field | Matrix |
| --- | --- |
| Required account type | Calendly paid test user/org when webhooks or Scheduling API paths require it; OAuth app for multi-user grants or PAT for single dedicated test account. |
| OAuth scopes/API permissions | Read: `user:read`, `event_types:read`, `scheduled_events:read`; webhooks: `webhooks:write`; scheduling/admin paths need additional scoped approval as implemented. |
| Env vars/secrets | `CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`, `CALENDLY_REDIRECT_URI`, `CALENDLY_REFRESH_TOKEN`, `CALENDLY_PAT`, `CALENDLY_TEST_USER_URI`, `CALENDLY_TEST_EVENT_TYPE_URI`. |
| Webhook/public URL setup | Public HTTPS webhook subscription for invitee created/canceled events; verify provider signing secret if configured and persist subscription IDs. |
| Sandbox/test account requirements | Test Calendly user with one event type and a second email identity for booking/canceling smoke. |
| Mock env var equivalent | Current: `ELIZA_MOCK_CALENDLY_BASE`. |
| Live read smoke | Read current user, event types, and recent scheduled events. |
| Live write smoke | Create webhook subscription; if Scheduling API is enabled, create/cancel a test booking in an allowlisted event type. |
| Cleanup/sweeper | Delete webhook subscriptions by run ID; cancel test bookings; remove local invitee state. |
| CI secret names/placeholders | `LIFEOPS_CALENDLY_CLIENT_ID`, `LIFEOPS_CALENDLY_CLIENT_SECRET`, `LIFEOPS_CALENDLY_REFRESH_TOKEN`, `LIFEOPS_CALENDLY_PAT`, `LIFEOPS_CALENDLY_TEST_EVENT_TYPE_URI`. |
| Safety gates | Do not book against real event types; use test availability windows; bounded webhook subscription count. |

## Travel providers: Duffel, Amadeus, Hotelbeds options

| Field | Matrix |
| --- | --- |
| Required account type | Pick one primary flight provider and one lodging provider. Duffel: account with test and later live tokens. Amadeus: Self-Service developer app with test environment credentials and production approval when needed. Hotelbeds: APItude partner/test credentials through commercial onboarding. |
| OAuth scopes/API permissions | Duffel uses bearer access token, separate test/live token. Amadeus uses API key/secret exchanged through OAuth client-credentials for access token. Hotelbeds commonly uses API key/secret/signature headers for APItude. |
| Env vars/secrets | `DUFFEL_ACCESS_TOKEN`, `DUFFEL_ENV=test`; `AMADEUS_API_KEY`, `AMADEUS_API_SECRET`, `AMADEUS_BASE_URL`; `HOTELBEDS_API_KEY`, `HOTELBEDS_SECRET`, `HOTELBEDS_BASE_URL`. |
| Webhook/public URL setup | Duffel order/change webhooks if booking lifecycle is implemented; provider callbacks must use a public HTTPS URL and signature/shared-secret verification where offered. |
| Sandbox/test account requirements | Duffel test token (`duffel_test_...`) and test cards/airline fixtures; Amadeus test environment with cached data expectations; Hotelbeds test endpoint and booking cancellation rules. |
| Mock env var equivalent | None exists yet. Proposed future env vars: `ELIZA_MOCK_DUFFEL_BASE`, `ELIZA_MOCK_AMADEUS_BASE`, `ELIZA_MOCK_HOTELBEDS_BASE` only after production clients have matching provider seams. |
| Live read smoke | Search offers/availability for fixed low-risk routes/dates and hotel destinations; read provider account metadata if available. |
| Live write smoke | Duffel: create a test order only in test mode. Amadeus/Hotelbeds: no live booking in CI unless provider sandbox supports reversible booking; otherwise write smoke stops at quote/hold/test booking. |
| Cleanup/sweeper | Cancel test orders/bookings/holds; expire local offers; never leave unpaid live holds without TTL tracking. |
| CI secret names/placeholders | `LIFEOPS_DUFFEL_TEST_ACCESS_TOKEN`, `LIFEOPS_AMADEUS_TEST_API_KEY`, `LIFEOPS_AMADEUS_TEST_API_SECRET`, `LIFEOPS_HOTELBEDS_TEST_API_KEY`, `LIFEOPS_HOTELBEDS_TEST_SECRET`. |
| Safety gates | No production ticketing/booking in CI; require `TRAVEL_LIVE_BOOKING_APPROVED=1`, price cap, passenger fixture only, explicit cancellation path, and manual review for anything that can charge money. |

## Notifications: ntfy, APNs, FCM

| Field | Matrix |
| --- | --- |
| Required account type | ntfy: self-hosted server or controlled ntfy.sh topic with access tokens. APNs: Apple Developer Program team and app bundle ID with push entitlement. FCM: Firebase project and app registrations for Android/iOS/web. |
| OAuth scopes/API permissions | ntfy token with publish/subscribe rights for test topics. APNs provider authentication token using Apple Team ID, Key ID, bundle topic, `.p8` key. FCM HTTP v1 uses Google service account access to Firebase Messaging for the project. |
| Env vars/secrets | `NTFY_BASE_URL`, `NTFY_TOPIC`, `NTFY_TOKEN`; `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY_P8`, `APNS_ENV`; `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`, `FCM_TEST_DEVICE_TOKEN`. |
| Webhook/public URL setup | Push providers do not need inbound webhook for send; delivery/open tracking requires app callbacks. ntfy subscribe smoke may use HTTP stream/SSE. |
| Sandbox/test account requirements | Dedicated topics and test device tokens; separate APNs sandbox vs production bundle; Firebase test app/device group. |
| Mock env var equivalent | None exists yet. Proposed future env vars should be provider-specific, for example `ELIZA_MOCK_NTFY_BASE`, `ELIZA_MOCK_APNS_BASE`, or `ELIZA_MOCK_FCM_BASE`, only after the real notification provider is selected. |
| Live read smoke | ntfy subscribe to test topic and receive one local publish; verify FCM/APNs credentials can mint/send auth requests without production token. |
| Live write smoke | Publish one ntfy message; send one APNs sandbox push to test device; send one FCM data notification to test device token. |
| Cleanup/sweeper | Delete/expire ntfy test topics where self-hosted; invalidate stale device tokens locally; rotate APNs/FCM credentials on compromise. |
| CI secret names/placeholders | `LIFEOPS_NTFY_BASE_URL`, `LIFEOPS_NTFY_TOPIC`, `LIFEOPS_NTFY_TOKEN`, `LIFEOPS_APNS_TEAM_ID`, `LIFEOPS_APNS_KEY_ID`, `LIFEOPS_APNS_PRIVATE_KEY_P8`, `LIFEOPS_FCM_PROJECT_ID`, `LIFEOPS_FCM_SERVICE_ACCOUNT_JSON`, `LIFEOPS_FCM_TEST_DEVICE_TOKEN`. |
| Safety gates | Never push to production device token in CI; message body must include run ID and no sensitive content; APNs environment must match token provenance. |

## Cloudflare

| Field | Matrix |
| --- | --- |
| Required account type | Cloudflare account with Workers paid plan if using Containers/Sandboxes; test zone/subdomain; isolated account or project for CI. |
| OAuth scopes/API permissions | API token with least privilege: Account Workers Scripts write/read, Workers Routes write if needed, KV/R2/D1/Queues read/write only for test namespaces, Zone DNS edit only for test zone, Logs read if smoke reads logs. |
| Env vars/secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_TEST_NAMESPACE_ID`, `CLOUDFLARE_R2_BUCKET`, `CLOUDFLARE_PUBLIC_HOSTNAME`. |
| Webhook/public URL setup | Public Worker route for callbacks; optional Access service token for private callbacks; custom domain DNS route if needed. |
| Sandbox/test account requirements | Dedicated test Worker, KV namespace, R2 bucket, queue, D1 database, container/sandbox class. |
| Mock env var equivalent | None exists yet. Cloudflare executor tests need either local Worker/Durable Object fixtures or staging resources; do not claim Mockoon proof until a real seam exists. |
| Live read smoke | Verify token, read account metadata, list/get test Worker or namespace metadata. |
| Live write smoke | Put/get/delete one KV key or R2 object tagged with run ID; deploy a no-op preview Worker only if deploy smoke is in scope. |
| Cleanup/sweeper | Delete run-ID KV keys/R2 objects, remove preview deployments/routes, stop containers/sandboxes, enforce TTL on Durable Object state. |
| CI secret names/placeholders | `LIFEOPS_CLOUDFLARE_API_TOKEN`, `LIFEOPS_CLOUDFLARE_ACCOUNT_ID`, `LIFEOPS_CLOUDFLARE_ZONE_ID`, `LIFEOPS_CLOUDFLARE_KV_NAMESPACE_ID`, `LIFEOPS_CLOUDFLARE_R2_BUCKET`. |
| Safety gates | Token cannot edit production zones; spend caps/alerts required for Containers; egress allowlist for cloud executors; redact command logs and artifacts. |

## OpenAI / Codex

| Field | Matrix |
| --- | --- |
| Required account type | OpenAI API organization/project with service account or project-scoped key; separate Codex/account flow only if product-approved. |
| OAuth scopes/API permissions | API key/project permissions for model inference, responses/files/vector stores as used; admin API key only for management smoke and never for normal runtime. |
| Env vars/secrets | `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, `OPENAI_ORG_ID`, `OPENAI_BASE_URL`; optional `OPENAI_ADMIN_API_KEY` for RBAC/key-management tests. Codex executor: `CODEX_HOME`, `CODEX_AUTH_MODE`, `CODEX_API_KEY` or product-approved account token. |
| Webhook/public URL setup | None for basic inference. Webhook/public URL only if using async callbacks, external tools, or hosted agent callbacks. |
| Sandbox/test account requirements | Dedicated project with budget cap and low rate limits; fixture prompts that cannot leak private code or secrets. |
| Mock env var equivalent | Existing LLM tests generally use model/test doubles rather than a central OpenAI Mockoon env. Add a provider-shaped mock only if the product path calls OpenAI HTTP directly in the tested lane. |
| Live read smoke | List/resolve model or run a one-token low-cost response; verify project/account metadata where available. |
| Live write smoke | Create/delete a small file/vector-store artifact only if those APIs are used; otherwise generation smoke is the write-equivalent billing event. |
| Cleanup/sweeper | Delete uploaded files/vector stores/threads created by run ID; usage monitor checks spend per run. |
| CI secret names/placeholders | `LIFEOPS_OPENAI_API_KEY`, `LIFEOPS_OPENAI_PROJECT_ID`, `LIFEOPS_OPENAI_ORG_ID`, `LIFEOPS_OPENAI_ADMIN_API_KEY`. |
| Safety gates | Project budget cap, no production user content in prompts, structured redaction logs, model allowlist, max token cap, no admin key in app runtime. |

## Anthropic / Claude

| Field | Matrix |
| --- | --- |
| Required account type | Anthropic Console workspace with billing and API key; Claude Code/Agent SDK should use API-key authentication unless an approved account-linking flow exists. |
| OAuth scopes/API permissions | API key grants Messages/Claude API access for the workspace; no OAuth scopes for standard API use. |
| Env vars/secrets | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, optional `CLAUDE_CODE_AUTH_TOKEN` only if product-approved. |
| Webhook/public URL setup | None for normal Messages API; tool callbacks must be app-owned and signed. |
| Sandbox/test account requirements | Dedicated workspace or key with low spend cap; prompt fixtures only. |
| Mock env var equivalent | Existing LLM tests generally use model/test doubles rather than a central Anthropic Mockoon env. Add a provider-shaped mock only if the product path calls Anthropic HTTP directly in the tested lane. |
| Live read smoke | Run a minimal low-token Messages API call and verify model availability. |
| Live write smoke | Generation smoke is the billable write-equivalent; no persistent provider artifact unless files/batches are used. |
| Cleanup/sweeper | No provider-side cleanup for simple messages; remove local transcripts and usage records by run ID. |
| CI secret names/placeholders | `LIFEOPS_ANTHROPIC_API_KEY`, `LIFEOPS_ANTHROPIC_MODEL`. |
| Safety gates | Workspace budget cap, max token cap, no private repo/user data unless explicitly testing executor redaction, no claude.ai subscription pass-through by default. |

## n8n

| Field | Matrix |
| --- | --- |
| Required account type | Dedicated n8n Cloud workspace or self-hosted instance for CI. |
| OAuth scopes/API permissions | n8n public API key sent as `X-N8N-API-KEY`; downstream workflow credentials are provider-specific and should remain in the n8n credential store, not LifeOps CI secrets, unless the test explicitly provisions them. |
| Env vars/secrets | `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_TEST_WORKFLOW_ID`, `N8N_WEBHOOK_SECRET`. |
| Webhook/public URL setup | Public webhook URL for trigger nodes; secure with path entropy plus shared secret/header validation. |
| Sandbox/test account requirements | Test workflow namespace/folder, disabled-by-default workflows, test credentials only. |
| Mock env var equivalent | None exists yet. A stateful n8n dispatch/execution mock must be added before n8n scenarios count as provider-mock proof. |
| Live read smoke | Fetch user/project/workflow metadata and list the known test workflow. |
| Live write smoke | Create/update a temporary workflow or trigger the test workflow with run ID and assert execution result. |
| Cleanup/sweeper | Delete temporary workflows/executions where supported; disable test workflow after run if CI enabled it. |
| CI secret names/placeholders | `LIFEOPS_N8N_BASE_URL`, `LIFEOPS_N8N_API_KEY`, `LIFEOPS_N8N_TEST_WORKFLOW_ID`, `LIFEOPS_N8N_WEBHOOK_SECRET`. |
| Safety gates | No production workflows; write smoke confined to `lifeops-test-*`; do not export decrypted downstream credentials into logs. |

## GitHub

| Field | Matrix |
| --- | --- |
| Required account type | Dedicated GitHub org or repo for LifeOps CI smoke; GitHub App preferred for product integration, fine-grained PAT acceptable for local/temporary smoke. |
| OAuth scopes/API permissions | GitHub App permissions by capability: Contents read/write, Issues read/write, Pull requests read/write, Actions read if CI inspection, Actions secrets write only for secret-management tests, Metadata read. Fine-grained PAT should target only test repos. |
| Env vars/secrets | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_TOKEN`, `GITHUB_TEST_OWNER`, `GITHUB_TEST_REPO`. |
| Webhook/public URL setup | Public HTTPS GitHub App webhook endpoint with webhook secret; validate `X-Hub-Signature-256` and delivery ID. |
| Sandbox/test account requirements | Dedicated test repository with branch protection variant, issue labels, and disposable branches. |
| Mock env var equivalent | Current: `ELIZA_MOCK_GITHUB_BASE`, `GITHUB_API_URL`, plus Octokit-shaped fixtures where the product uses Octokit directly. |
| Live read smoke | Fetch installation/repo metadata, list issues/PRs, read one file from test repo. |
| Live write smoke | Create/update/delete a test branch/file or issue labeled with run ID; optional draft PR in test repo. |
| Cleanup/sweeper | Close test issues/PRs, delete run-ID branches, remove test labels if created. |
| CI secret names/placeholders | `LIFEOPS_GITHUB_APP_ID`, `LIFEOPS_GITHUB_APP_PRIVATE_KEY`, `LIFEOPS_GITHUB_APP_INSTALLATION_ID`, `LIFEOPS_GITHUB_WEBHOOK_SECRET`, `LIFEOPS_GITHUB_TEST_OWNER`, `LIFEOPS_GITHUB_TEST_REPO`. |
| Safety gates | Never grant org-wide write unless required; test repo allowlist; no secret writes outside secret-management smoke; redact private key and tokens. |

## Browser Portal

| Field | Matrix |
| --- | --- |
| Required account type | LifeOps-owned browser automation portal account or self-hosted portal tenant; provider accounts used inside browser sessions must be dedicated test accounts. |
| OAuth scopes/API permissions | Portal API token with session create/read/stop and artifact read; no broad credential vault access in CI unless the test is specifically about vault integration. |
| Env vars/secrets | `BROWSER_PORTAL_BASE_URL`, `BROWSER_PORTAL_API_KEY`, `BROWSER_PORTAL_PROJECT_ID`, `BROWSER_PORTAL_TEST_PROFILE_ID`. |
| Webhook/public URL setup | Optional session-complete callback to public signed endpoint; artifact URLs must be private or short-lived. |
| Sandbox/test account requirements | Disposable browser profile with no production cookies; test-only credentials; network egress policy for sensitive domains. |
| Mock env var equivalent | Current browser-workspace mock: `ELIZA_BROWSER_WORKSPACE_URL`, `ELIZA_BROWSER_WORKSPACE_TOKEN`, `ELIZA_DISABLE_DISCORD_DESKTOP_CDP=1`. A distinct Browser Portal provider needs its own env vars only if it becomes a separate production surface. |
| Live read smoke | Create a session, open a static test URL, fetch screenshot/DOM artifact. |
| Live write smoke | Fill and submit a LifeOps-owned test form; no third-party purchase/account changes in CI. |
| Cleanup/sweeper | Stop sessions, delete browser profiles/artifacts older than TTL, purge downloaded files. |
| CI secret names/placeholders | `LIFEOPS_BROWSER_PORTAL_BASE_URL`, `LIFEOPS_BROWSER_PORTAL_API_KEY`, `LIFEOPS_BROWSER_PORTAL_PROJECT_ID`, `LIFEOPS_BROWSER_PORTAL_TEST_PROFILE_ID`. |
| Safety gates | No production cookies, no payment/autofill profiles, domain allowlist, artifact redaction, session timeout and kill switch. |

## HealthKit, Screen Time, macOS permissions

| Field | Matrix |
| --- | --- |
| Required account type | Apple Developer Program team for entitlements; dedicated physical iOS/macOS test devices and local test user. Screen Time / FamilyControls entitlements may require Apple approval. |
| OAuth scopes/API permissions | Native entitlements and runtime permissions, not OAuth. HealthKit read/write types must be individually requested. Screen Time uses FamilyControls/DeviceActivity/ManagedSettings entitlements. macOS requires TCC permissions such as Accessibility, Automation, Full Disk Access, Calendar/Contacts/Reminders, Screen Recording as applicable. |
| Env vars/secrets | `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `MACOS_BUNDLE_ID`, `HEALTHKIT_TEST_DEVICE_ID`, `SCREENTIME_TEST_DEVICE_ID`, `MACOS_TEST_HOST_ID`; signing secrets should stay in platform CI secret store, not plain env where possible. |
| Webhook/public URL setup | None for local permission smoke; sync backends need signed app-to-server upload endpoints. |
| Sandbox/test account requirements | Physical devices with test Apple ID, fake HealthKit samples, test Screen Time category/app limits, macOS test user with disposable home directory. Simulators are insufficient for several permission paths. |
| Mock env var equivalent | Current presence mocks live under `test/mocks/environments/lifeops-presence.json`. Future native permission mocks should point to concrete helper seams, not generic `MOCK_*` flags. |
| Live read smoke | Verify permission status and read one seeded HealthKit sample, one DeviceActivity summary, or one macOS permission-protected resource from the test host. |
| Live write smoke | Write/delete a fake HealthKit sample; apply/remove a Screen Time test shield/limit; request and verify macOS permission prompt flow in a disposable test user. |
| Cleanup/sweeper | Delete HealthKit samples by metadata run ID, remove Screen Time shields/limits, reset TCC permissions on test host, revoke test device tokens. |
| CI secret names/placeholders | `LIFEOPS_APPLE_TEAM_ID`, `LIFEOPS_IOS_BUNDLE_ID`, `LIFEOPS_MACOS_BUNDLE_ID`, `LIFEOPS_HEALTHKIT_TEST_DEVICE_ID`, `LIFEOPS_SCREENTIME_TEST_DEVICE_ID`, `LIFEOPS_MACOS_TEST_HOST_ID`. |
| Safety gates | Physical-device live lane only; no owner health data; permission prompts must show exact requested types; Screen Time changes require explicit local confirmation outside CI unless using a supervised disposable device. |

## Source anchors checked

- Google OAuth scope catalog: https://developers.google.com/identity/protocols/oauth2/scopes
- Discord OAuth2 and permissions: https://docs.discord.com/developers/platform/oauth2-and-permissions
- Telegram Bot API: https://core.telegram.org/bots/api
- Twilio messaging webhooks: https://www.twilio.com/docs/usage/webhooks/messaging-webhooks
- X OAuth 2.0 scopes and DM requirements: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code and https://docs.x.com/x-api/direct-messages/manage/integrate
- Calendly scopes and webhooks: https://developer.calendly.com/scopes and https://help.calendly.com/hc/en-us/articles/223195488-Getting-started-with-webhooks
- Duffel test mode: https://duffel.com/docs/api/overview/test-mode/duffel-airways
- Amadeus API keys and test environment: https://developers.amadeus.com/self-service/apis-docs/guides/developer-guides/API-Keys/
- ntfy auth and publish/subscribe: https://docs.ntfy.sh/config/ and https://docs.ntfy.sh/publish/
- APNs token auth: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- Firebase Cloud Messaging server credentials: https://firebase.google.com/docs/cloud-messaging/server
- Cloudflare API token permissions: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- OpenAI project/API key management: https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform
- Anthropic API key usage: https://docs.anthropic.com/en/api/overview
- n8n API authentication: https://docs.n8n.io/api/authentication/
- GitHub fine-grained token permissions: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- BlueBubbles REST API and Private API: https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks and https://docs.bluebubbles.app/private-api/installation
- signal-cli JSON-RPC usage: https://packaging.gitlab.io/signal-cli/usage/index.html
