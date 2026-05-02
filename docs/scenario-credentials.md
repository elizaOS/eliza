# Scenario Matrix — Credentials & Test Account Playbook

This document is the operator-facing playbook for provisioning every external test account the scenario matrix needs. It covers:

- Account identifiers (which test user / bot / workspace / API app to create)
- Required permissions and scopes
- How to capture credentials into the `eliza-e2e` 1Password vault
- The exact `ELIZA_E2E_*` env-var names the `CredentialBroker` in `@elizaos/scenario-runner` resolves
- Rotation schedule and the GitHub Actions rotation workflow
- Per-integration side-effect isolation and cleanup contract

Everything here is specific to the scenario matrix — do NOT reuse these credentials for production runtimes or for developer daily-driver integrations.

---

## Naming convention

The `CredentialBroker` resolves `service:tag` identifiers from scenarios into env vars.

**Identifier format in scenarios:**

```ts
requires: {
  credentials: ["gmail:test-agent", "twilio:sandbox-primary"];
}
```

**Env-var prefix derivation rule:**

```
service:tag  →  ELIZA_E2E_<SERVICE>_<TAG>_*
```

with `-` and `:` replaced by `_`, and the whole prefix upper-cased. The suffix varies per service (token, secret, ID, etc.) and is specified in each section below.

All scenario-matrix env vars MUST start with `ELIZA_E2E_`. Anything else in the environment is treated as untrusted by the broker and is NOT forwarded into the runtime.

---

## Central vault — `eliza-e2e` (1Password)

Everything below lives in a 1Password vault named `eliza-e2e`. Access control:

| Role            | People             | What they can do                                  |
| --------------- | ------------------ | ------------------------------------------------- |
| Owner           | 1 engineering lead | Rotate, revoke, add new items                     |
| Operator        | 2–3 ops-on-call    | Read any item, add rotation entries               |
| Service Account | `eliza-e2e-ci`    | Read-only API access used by CI rotation workflow |

The 1Password CLI (`op`) is the canonical surface; never copy credentials to other vaults or to local `.env` files that aren't `.gitignore`d.

### Pulling credentials locally

```bash
# One-time: sign in
op signin --account eliza.1password.com

# Fetch all scenario-matrix creds into a local .env file
bun run scenarios:creds:pull     # implemented in scripts/scenario-creds-pull.mjs (T11)
```

This writes `.env.scenarios` at the repo root. The file is in `.gitignore`. The runner's CredentialBroker auto-loads `.env.scenarios` when it starts and falls back to `process.env`.

### Pushing credentials to GitHub Actions secrets

A GitHub Actions workflow at `.github/workflows/rotate-e2e-secrets.yml` runs monthly (cron `0 4 1 * *`) and whenever `rotate-e2e-secrets` label is applied to an issue. It uses the `eliza-e2e-ci` service account to read the vault and then updates every `ELIZA_E2E_*` GitHub Actions secret via the `gh` CLI. See `.github/workflows/rotate-e2e-secrets.yml`.

---

## Accounts, in alphabetical order

### 1. Apple Developer — iOS companion + BlueBubbles signing

**What to create**

- Apple Developer Program membership under the `Eliza E2E` organization (separate from the production Apple ID).
- App Group `group.com.eliza.e2e` for the iOS companion app bundle + BlueBubbles server.
- Provisioning profile for `com.eliza.e2e.companion` with `Push Notifications` capability.
- APNs key (`.p8`) with development + production permission.

**Scopes / capabilities**

- Push notifications
- App Groups
- Background Modes: `remote-notification`, `audio` (for call routing tests)

**1Password items**

- `eliza-e2e / apple / team-id` — Team ID
- `eliza-e2e / apple / apns-key.p8` — APNs key (file attachment)
- `eliza-e2e / apple / apns-key-id` — APNs key ID
- `eliza-e2e / apple / apns-topic` — `com.eliza.e2e.companion.voip`

**Env vars**

- `ELIZA_E2E_APPLE_TEAM_ID`
- `ELIZA_E2E_APPLE_APNS_KEY_ID`
- `ELIZA_E2E_APPLE_APNS_KEY_P8` (base64-encoded PEM)
- `ELIZA_E2E_APPLE_APNS_TOPIC`

**Rotation** — annual, or after any staffing change on the Apple Developer account.

**Cleanup** — no scenario-level cleanup; test push notifications auto-expire.

---

### 2. BlueBubbles — iMessage bridge

**What to create**

- Dedicated Mac mini (or Mac Studio) on the engineering LAN running macOS 14+.
- Dedicated Apple ID `eliza-e2e-imessage@<domain>` logged into iMessage on that Mac.
- BlueBubbles server installed and bound to `127.0.0.1` behind a Tailscale ingress (not exposed to the public internet).
- A dedicated test-only recipient directory: a second Apple ID on another device is the only allowed outbound target.

**1Password items**

- `eliza-e2e / bluebubbles / server-url` — e.g. `http://bluebubbles-e2e.tail-scope.ts.net`
- `eliza-e2e / bluebubbles / password` — server password
- `eliza-e2e / bluebubbles / recipient-handle` — iMessage handle of the paired test recipient

**Env vars**

- `ELIZA_E2E_BLUEBUBBLES_SERVER_URL`
- `ELIZA_E2E_BLUEBUBBLES_PASSWORD`
- `ELIZA_E2E_BLUEBUBBLES_RECIPIENT_HANDLE`

**Rotation** — password every 30 days; Apple ID password every 90 days.

**Side-effect isolation**

- Scenarios MUST set recipient equal to `ELIZA_E2E_BLUEBUBBLES_RECIPIENT_HANDLE`. The runner's iMessage send path rejects any other recipient.
- All sent messages are prefixed with `[e2e-<runId>]` for easier audit.

**Cleanup** — orphan sweeper (see §Orphan sweeper) deletes iMessage threads with `[e2e-` prefix older than 24h on the paired device. Because deletion is Apple-controlled, on-device cleanup is a "best effort" archive operation.

---

### 3. Calendly — scheduling-with-others

**What to create**

- Calendly Standard tier account for `eliza-e2e-host@<domain>`.
- One event type named `E2E 30-min Sync` (30 minutes, single slot).
- Personal access token (Developer API) scoped to that account.

**Scopes**

- `default` — Calendly tokens are account-wide.

**1Password items**

- `eliza-e2e / calendly / access-token`
- `eliza-e2e / calendly / host-uri` — `https://calendly.com/eliza-e2e-host`
- `eliza-e2e / calendly / event-type-uri`

**Env vars**

- `ELIZA_E2E_CALENDLY_ACCESS_TOKEN`
- `ELIZA_E2E_CALENDLY_HOST_URI`
- `ELIZA_E2E_CALENDLY_EVENT_TYPE_URI`

**Rotation** — token every 60 days.

**Side-effect isolation** — only book slots labeled `e2e-<runId>`. Cancel via the `/scheduled_events/{uuid}/cancellation` endpoint during cleanup.

---

### 4. Discord — local client + bot

**What to create**

- Developer Application `Eliza E2E` → Bot user.
- A test guild `eliza-e2e-guild` with a small number of channels: `#dm-relay-tests`, `#group-tests`, `#bot-commands`.
- Invite the bot with permissions `Send Messages, Read Message History, Manage Messages` (latter is needed for cleanup).
- A second user account `eliza-e2e-user` (personal Discord account with 2FA) used to simulate human DMs to the bot.

**Scopes**

- Bot scopes: `bot`, `messages.read`, `guilds`.
- OAuth2 scopes (for the user login flow): `identify`, `email`, `guilds`, `messages.read`.

**1Password items**

- `eliza-e2e / discord / bot-token`
- `eliza-e2e / discord / client-id`
- `eliza-e2e / discord / client-secret`
- `eliza-e2e / discord / qa-guild-id` — already present in the repo's `discord-*-live.ts` as `DISCORD_QA_GUILD_ID="1051457140637827122"`; use a new test guild in its place
- `eliza-e2e / discord / qa-channel-id`
- `eliza-e2e / discord / user-relay-token` — OAuth refresh token for `eliza-e2e-user`

**Env vars** (the matrix intentionally uses new `ELIZA_E2E_*` prefixes rather than the existing `DISCORD_BOT_TOKEN` to keep scenario-matrix creds isolated from production)

- `ELIZA_E2E_DISCORD_BOT_TOKEN`
- `ELIZA_E2E_DISCORD_CLIENT_ID`
- `ELIZA_E2E_DISCORD_CLIENT_SECRET`
- `ELIZA_E2E_DISCORD_QA_GUILD_ID`
- `ELIZA_E2E_DISCORD_QA_CHANNEL_ID`
- `ELIZA_E2E_DISCORD_USER_RELAY_TOKEN`

**Rotation** — bot token quarterly; OAuth refresh token whenever Discord invalidates it.

**Side-effect isolation**

- Bot only writes to the test guild.
- DM simulation uses `eliza-e2e-user` only — scenarios MUST NOT invoke arbitrary Discord user IDs.

**Cleanup** — orphan sweeper deletes messages authored by the bot older than 24h.

---

### 5. Gmail / Google Workspace

**What to create**

- A Google Workspace `eliza-e2e.test` domain (any `.test` TLD or `.eliza-e2e.dev` if a real TLD is needed for deliverability testing).
- Two mailboxes:
  - `test-owner@eliza-e2e.test` (the user being simulated)
  - `test-agent@eliza-e2e.test` (the agent's own Gmail account)
- Admin-enabled Gmail API access, Calendar API access, People API access.
- A GCP project `eliza-e2e-gcp` with OAuth consent screen configured (Internal, since Workspace-internal).
- OAuth client of type `Desktop app` for each mailbox. Use the Gmail send/modify/readonly scopes.

**Scopes**

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/contacts`

**1Password items** (one pair per mailbox)

- `eliza-e2e / gmail / test-owner / client-id`
- `eliza-e2e / gmail / test-owner / client-secret`
- `eliza-e2e / gmail / test-owner / refresh-token`
- (same three for `test-agent`)

**Env vars**

- `ELIZA_E2E_GMAIL_TESTOWNER_CLIENT_ID`
- `ELIZA_E2E_GMAIL_TESTOWNER_CLIENT_SECRET`
- `ELIZA_E2E_GMAIL_TESTOWNER_REFRESH_TOKEN`
- `ELIZA_E2E_GMAIL_TESTOWNER_ADDRESS` — `test-owner@eliza-e2e.test`
- `ELIZA_E2E_GMAIL_TESTAGENT_CLIENT_ID`
- `ELIZA_E2E_GMAIL_TESTAGENT_CLIENT_SECRET`
- `ELIZA_E2E_GMAIL_TESTAGENT_REFRESH_TOKEN`
- `ELIZA_E2E_GMAIL_TESTAGENT_ADDRESS` — `test-agent@eliza-e2e.test`

Same pattern for Calendar/Contacts — the refresh token carries all the scopes.

**Rotation** — refresh tokens every 90 days; client secrets every 180 days.

**Side-effect isolation**

- All drafts and sent mail tagged with a Gmail label `eliza-e2e` + run-specific label `eliza-e2e-<runId>`.
- Scenarios that send email may only send to `test-owner` or `test-agent` or a configured allowlist (no external recipients).
- Calendar events prefixed with `[e2e]` in the summary.
- Real Gmail scenarios default to read-only. Write scenarios require an explicit allow flag, recipient allowlist, run label/header, and a working Gmail sweeper.
- Real owner mailbox captures must not be committed. Exporters should write raw data only to ignored local paths and emit redacted/synthetic fixtures after validation.

**Cleanup** — orphan sweeper deletes drafts with the `eliza-e2e` label older than 24h and removes the per-run label.

---

### 6. GitHub — issues / PRs / code review

**What to create**

- Two accounts: `eliza-e2e-user` and `eliza-e2e-agent`.
- A dedicated test organization `eliza-e2e-org`. Both accounts are members.
- A template repository `eliza-e2e-org/e2e-scratch` with a CI-friendly structure (issue templates, CODEOWNERS pointing at both accounts).
- Fine-grained PATs for each account restricted to `eliza-e2e-org`, scoped `issues:write`, `pull_requests:write`, `contents:write`, `metadata:read`.

**1Password items**

- `eliza-e2e / github / user-pat`
- `eliza-e2e / github / agent-pat`
- `eliza-e2e / github / org-name` — `eliza-e2e-org`
- `eliza-e2e / github / template-repo` — `eliza-e2e-org/e2e-scratch`

**Env vars**

- `ELIZA_E2E_GITHUB_USER_PAT`
- `ELIZA_E2E_GITHUB_AGENT_PAT`
- `ELIZA_E2E_GITHUB_ORG` — `eliza-e2e-org`
- `ELIZA_E2E_GITHUB_TEMPLATE_REPO` — `eliza-e2e-org/e2e-scratch`

**Rotation** — PATs every 90 days (GitHub enforces max 1-year expiry on fine-grained PATs).

**Side-effect isolation**

- Scenarios create a scratch repo per run named `e2e-<runId>`, then delete it at cleanup time.
- No scenario may push to `e2e-scratch` main branch directly.

**Cleanup** — orphan sweeper deletes any `e2e-*` repo older than 24h.

---

### 7. 1Password E2E vault (autofill tests)

**What to create**

- A second 1Password vault called `eliza-e2e-autofill` (distinct from the credential vault).
- Pre-seeded items for the allow-listed autofill sites used by scenarios (GitHub, Gmail, Stripe dashboard in test mode, Figma, Notion — one dummy login each).
- A 1Password Service Account `eliza-e2e-ci-autofill` with read-only access.

**Scopes**

- Vault read on `eliza-e2e-autofill` only.

**1Password items**

- `eliza-e2e / 1password-autofill / service-account-token`
- `eliza-e2e / 1password-autofill / vault-id`

**Env vars**

- `ELIZA_E2E_ONEPASS_SA_TOKEN`
- `ELIZA_E2E_ONEPASS_VAULT_ID`

**Rotation** — service-account token every 90 days.

**Side-effect isolation** — autofill scenarios use only the dummy logins in this vault. Never the production or operator credential vaults.

**Cleanup** — no cleanup; the vault is static.

---

### 8. Signal — secure messaging

**What to create**

- Dedicated phone number purchased via Twilio (see §Twilio) and registered with Signal under a fresh device.
- Install `signal-cli` on the CI Mac runner and register the phone number with it; store the registration data dir at `~/.signal-cli/e2e`.
- A second Signal account (separate phone number) as the paired test recipient.

**Scopes**

- Signal has no scope system; registration is the credential.

**1Password items**

- `eliza-e2e / signal / phone-number`
- `eliza-e2e / signal / registration-lock-pin`
- `eliza-e2e / signal / data-dir-archive` — tar.gz of `~/.signal-cli/e2e` snapshot
- `eliza-e2e / signal / recipient-phone-number`

**Env vars**

- `ELIZA_E2E_SIGNAL_PHONE_NUMBER`
- `ELIZA_E2E_SIGNAL_RECIPIENT_PHONE_NUMBER`
- `ELIZA_E2E_SIGNAL_DATA_DIR` — path on runner, e.g. `/var/eliza/signal-cli`

**Rotation** — re-verify phone number yearly or after any signal-cli data loss. PIN every 180 days.

**Side-effect isolation** — scenarios send only to `ELIZA_E2E_SIGNAL_RECIPIENT_PHONE_NUMBER`. Any other recipient is rejected by the scenario-runner's Signal adapter.

**Cleanup** — sweeper deletes signal-cli local message history older than 24h.

---

### 9. Telegram — DM + bot

**What to create**

- Bot via BotFather: `ElizaE2EBot` — token captured.
- MTProto userbot account on a dedicated phone number (needed for reading DMs the way the `service-mixin-telegram.ts` code path does).
- App ID + hash via https://my.telegram.org → `eliza-e2e-telegram` app.

**Scopes** — Telegram uses access hashes; no OAuth scopes.

**1Password items**

- `eliza-e2e / telegram / bot-token`
- `eliza-e2e / telegram / app-id`
- `eliza-e2e / telegram / app-hash`
- `eliza-e2e / telegram / userbot-phone-number`
- `eliza-e2e / telegram / userbot-session-string`

**Env vars**

- `ELIZA_E2E_TELEGRAM_BOT_TOKEN`
- `ELIZA_E2E_TELEGRAM_APP_ID`
- `ELIZA_E2E_TELEGRAM_APP_HASH`
- `ELIZA_E2E_TELEGRAM_USERBOT_PHONE_NUMBER`
- `ELIZA_E2E_TELEGRAM_USERBOT_SESSION_STRING`
- `ELIZA_E2E_TELEGRAM_CHAT_ID` — the pinned test chat ID

**Rotation** — session string every 90 days (telegram invalidates stale sessions).

**Side-effect isolation** — bot operates only in chats it has been invited to; scenarios list those chats as seed context.

**Cleanup** — bot deletes its own messages older than 24h via `deleteMessage`.

---

### 10. Twilio — SMS + voice gateway

**What to create**

- A Twilio trial or paid account under the `eliza-e2e` workspace.
- Two phone numbers:
  - `ELIZA_E2E_TWILIO_SMS_FROM` — for SMS-only scenarios
  - `ELIZA_E2E_TWILIO_VOICE_FROM` — for voice scenarios
- An API Key + Secret (NOT the account SID token — keys are rotatable).
- Messaging Service SID for SMS routing (cleaner than raw from-number).
- A dedicated paired recipient phone number (in the same country for delivery reliability) stored as `ELIZA_E2E_TWILIO_RECIPIENT`.

**Scopes** — Twilio uses API key permissions.

- `Main` key (full access) — kept for administrative tasks only
- `Restricted` key with only `Messaging.Send`, `Voice.Initiate`, `Recordings.Read`, `Conversations.Read`

**1Password items**

- `eliza-e2e / twilio / account-sid`
- `eliza-e2e / twilio / api-key-sid`
- `eliza-e2e / twilio / api-key-secret`
- `eliza-e2e / twilio / sms-from-number`
- `eliza-e2e / twilio / voice-from-number`
- `eliza-e2e / twilio / messaging-service-sid`
- `eliza-e2e / twilio / recipient-number`

**Env vars**

- `ELIZA_E2E_TWILIO_ACCOUNT_SID`
- `ELIZA_E2E_TWILIO_API_KEY_SID`
- `ELIZA_E2E_TWILIO_API_KEY_SECRET`
- `ELIZA_E2E_TWILIO_SMS_FROM`
- `ELIZA_E2E_TWILIO_VOICE_FROM`
- `ELIZA_E2E_TWILIO_MESSAGING_SERVICE_SID`
- `ELIZA_E2E_TWILIO_RECIPIENT`

**Rotation** — API key every 30 days. Numbers never rotate.

**Side-effect isolation**

- Scenarios must send SMS/voice only to `ELIZA_E2E_TWILIO_RECIPIENT`. Any other destination number causes the scenario-runner's Twilio adapter to throw `DisallowedRecipientError` BEFORE contacting Twilio, so we never pay for a rogue message.
- Daily cost alarm in Twilio set at $5/day.

**Cleanup** — Twilio auto-purges delivered SMS after 30 days; no scenario-level cleanup needed. Call recordings deleted by sweeper after 24h.

---

### 11. Twitter / X — feed + DMs

**What to create**

- Developer account under an X Premium handle `@eliza_e2e`.
- X API v2 app `Eliza E2E`, Essential access minimum.
- OAuth 2.0 PKCE client for user-context operations (DM read/send requires user auth).
- A second X account `@eliza_e2e_friend` as the paired recipient.

**Scopes**

- `tweet.read`, `users.read`, `dm.read`, `dm.write`, `follows.read`.

**1Password items**

- `eliza-e2e / twitter / client-id`
- `eliza-e2e / twitter / client-secret`
- `eliza-e2e / twitter / user-refresh-token` — for `@eliza_e2e`
- `eliza-e2e / twitter / friend-refresh-token` — for `@eliza_e2e_friend` (used by tests to simulate inbound DMs)

**Env vars**

- `ELIZA_E2E_TWITTER_CLIENT_ID`
- `ELIZA_E2E_TWITTER_CLIENT_SECRET`
- `ELIZA_E2E_TWITTER_USER_REFRESH_TOKEN`
- `ELIZA_E2E_TWITTER_FRIEND_REFRESH_TOKEN`
- `ELIZA_E2E_TWITTER_USER_HANDLE` — `eliza_e2e`
- `ELIZA_E2E_TWITTER_FRIEND_HANDLE` — `eliza_e2e_friend`

**Rotation** — refresh tokens every 90 days; client secrets every 180 days.

**Side-effect isolation**

- DM scenarios only message `@eliza_e2e_friend`.
- Any post creation must include the string `e2e-<runId>`; scenarios MUST NOT post to a live audience. Feed-summarization scenarios use only read endpoints.

**Cleanup** — sweeper deletes posts containing `e2e-` older than 24h.

---

### 12. WhatsApp Business API

**What to create**

- Meta Business Suite account for `eliza-e2e`.
- A WhatsApp Business phone number (via Twilio or Meta directly).
- App + permanent access token — scopes `whatsapp_business_messaging`, `whatsapp_business_management`.
- A paired recipient phone number (real WhatsApp account).

**1Password items**

- `eliza-e2e / whatsapp / access-token`
- `eliza-e2e / whatsapp / phone-number-id`
- `eliza-e2e / whatsapp / business-account-id`
- `eliza-e2e / whatsapp / webhook-verify-token`
- `eliza-e2e / whatsapp / recipient-phone-number`

**Env vars** (overlap with existing plugin-whatsapp envs, but matrix uses its own namespace)

- `ELIZA_E2E_WHATSAPP_ACCESS_TOKEN`
- `ELIZA_E2E_WHATSAPP_PHONE_NUMBER_ID`
- `ELIZA_E2E_WHATSAPP_BUSINESS_ACCOUNT_ID`
- `ELIZA_E2E_WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `ELIZA_E2E_WHATSAPP_RECIPIENT_PHONE_NUMBER`
- `ELIZA_E2E_WHATSAPP_API_VERSION` — defaults `v24.0`

**Rotation** — access token every 90 days.

**Side-effect isolation** — outbound messages only to `ELIZA_E2E_WHATSAPP_RECIPIENT_PHONE_NUMBER`.

**Cleanup** — no sweeper; WhatsApp retention is at the API level.

---

### 13. Eliza Cloud (bridge / gateway / provider quotas)

**What to create**

- A `eliza-e2e` organization on Eliza Cloud.
- An API key scoped to inference + app deployment, with a `$50/month` spending cap.
- Separate rate-limit bucket from production.

**1Password items**

- `eliza-e2e / elizacloud / api-key`
- `eliza-e2e / elizacloud / base-url` — usually `https://api.elizaos.cloud`

**Env vars**

- `ELIZA_E2E_ELIZACLOUD_API_KEY`
- `ELIZA_E2E_ELIZACLOUD_BASE_URL`

**Rotation** — API key every 90 days.

---

### 14. LLM providers (for the scenario runner's `selectLiveProvider`)

The runner selects the cheapest available provider from its fallback chain. Provide at least Groq; OpenAI + Anthropic are optional fallbacks for when Groq rate-limits.

**1Password items**

- `eliza-e2e / llm / groq-api-key`
- `eliza-e2e / llm / openai-api-key`
- `eliza-e2e / llm / anthropic-api-key`

**Vault secrets (GitHub Actions secret names)**

- `ELIZA_E2E_GROQ_API_KEY`
- `ELIZA_E2E_OPENAI_API_KEY`
- `ELIZA_E2E_ANTHROPIC_API_KEY`

**Env vars exposed to the runner** (upstream-scoped; set from the vault secrets in `scenario-matrix.yml`):

- `ELIZA_E2E_GROQ_API_KEY`
- `ELIZA_E2E_OPENAI_API_KEY`
- `ELIZA_E2E_ANTHROPIC_API_KEY`

The runner also accepts the unscoped versions (`GROQ_API_KEY`, etc.) for local dev convenience. The canonical unscoped form wins when both are set; the `ELIZA_E2E_*` alias is used only when the canonical is unset.

**Rotation** — Groq every 60 days, OpenAI/Anthropic every 90 days.

**Cost guardrails** — each provider's dashboard should have a $50/month hard cap on the scenario-matrix keys.

---

## Rotation schedule — at a glance

| Credential                    | Interval        |
| ----------------------------- | --------------- |
| Twilio API key                | 30 days         |
| BlueBubbles server password   | 30 days         |
| Groq API key                  | 60 days         |
| Calendly token                | 60 days         |
| GitHub PATs                   | 90 days         |
| Gmail refresh tokens          | 90 days         |
| 1Password SA token            | 90 days         |
| Telegram session string       | 90 days         |
| Twitter refresh tokens        | 90 days         |
| WhatsApp access token         | 90 days         |
| OpenAI / Anthropic keys       | 90 days         |
| Eliza Cloud key               | 90 days         |
| BlueBubbles Apple ID password | 90 days         |
| Discord bot token             | quarterly       |
| Discord OAuth refresh token   | on invalidation |
| Gmail client secret           | 180 days        |
| Signal PIN                    | 180 days        |
| Twitter client secret         | 180 days        |
| Apple Developer materials     | yearly          |
| Signal registration           | yearly          |

Rotation workflow posts a failure message into the `#e2e-ops` Slack channel if any credential is within 7 days of expiry.

---

## Orphan sweeper contract

Every scenario `cleanup[]` runs in `finally`. If a scenario crashes before `finally`, artifacts leak. The nightly orphan sweeper (`.github/workflows/e2e-orphan-sweeper.yml`, runs at 04:00 UTC) is the safety net.

Sweeper responsibilities per integration:

| Integration | What the sweeper deletes                                         |
| ----------- | ---------------------------------------------------------------- |
| Gmail       | Drafts + labels matching `eliza-e2e-*` older than 24h           |
| Calendar    | Events with summary prefix `[e2e]` older than 24h                |
| Discord     | Bot-authored messages older than 24h in test guild               |
| Telegram    | Bot messages older than 24h                                      |
| Twitter     | Posts containing `e2e-` older than 24h                           |
| Signal      | `signal-cli` local message history older than 24h                |
| WhatsApp    | No-op (API retention)                                            |
| iMessage    | Archive threads with `[e2e-` prefix older than 24h (best effort) |
| GitHub      | Scratch repos named `e2e-*` older than 24h                       |
| Twilio      | Call recordings older than 24h                                   |
| SelfControl | Profiles with `e2e-` prefix (local to runner)                    |

Sweeper reports counts to the workflow's `GITHUB_STEP_SUMMARY`. Non-zero exit if any integration sweep fails — this alerts operators.

---

## `.env.scenarios` example (local dev)

```bash
# LLM (at least one required). Upstream-scoped alias — the scenario runner
# also accepts the canonical unscoped names (`GROQ_API_KEY`, etc.), which
# win if both are set.
ELIZA_E2E_GROQ_API_KEY=...

# Gmail
ELIZA_E2E_GMAIL_TESTOWNER_CLIENT_ID=...
ELIZA_E2E_GMAIL_TESTOWNER_CLIENT_SECRET=...
ELIZA_E2E_GMAIL_TESTOWNER_REFRESH_TOKEN=...
ELIZA_E2E_GMAIL_TESTOWNER_ADDRESS=test-owner@eliza-e2e.test
ELIZA_E2E_GMAIL_TESTAGENT_CLIENT_ID=...
ELIZA_E2E_GMAIL_TESTAGENT_CLIENT_SECRET=...
ELIZA_E2E_GMAIL_TESTAGENT_REFRESH_TOKEN=...
ELIZA_E2E_GMAIL_TESTAGENT_ADDRESS=test-agent@eliza-e2e.test

# Twilio
ELIZA_E2E_TWILIO_ACCOUNT_SID=...
ELIZA_E2E_TWILIO_API_KEY_SID=...
ELIZA_E2E_TWILIO_API_KEY_SECRET=...
ELIZA_E2E_TWILIO_SMS_FROM=+15551234567
ELIZA_E2E_TWILIO_VOICE_FROM=+15551234568
ELIZA_E2E_TWILIO_RECIPIENT=+15559876543
ELIZA_E2E_TWILIO_MESSAGING_SERVICE_SID=...

# Discord
ELIZA_E2E_DISCORD_BOT_TOKEN=...
ELIZA_E2E_DISCORD_CLIENT_ID=...
ELIZA_E2E_DISCORD_CLIENT_SECRET=...
ELIZA_E2E_DISCORD_QA_GUILD_ID=...
ELIZA_E2E_DISCORD_QA_CHANNEL_ID=...

# (and so on for each integration used by the scenarios you want to run)
```

Run `bun run scenarios:creds:pull` to have `op` fill this file from the vault.

---

## Adding a new credential

1. Add the item to the `eliza-e2e` vault in 1Password, respecting the naming convention (`eliza-e2e / <service> / <item>`).
2. Document it in this file — add the service section or extend an existing one.
3. Add the new `ELIZA_E2E_*` env var to the rotation workflow's secret list at `.github/workflows/rotate-e2e-secrets.yml`.
4. If the new integration needs cleanup, add a sweeper handler at `scripts/sweeper/<service>.ts` and wire into `.github/workflows/e2e-orphan-sweeper.yml`.
5. Update `@elizaos/scenario-runner`'s `CredentialBroker` tests to include the new resolution case.
6. Update `scripts/scenario-creds-pull.mjs` so `bun run scenarios:creds:pull` picks up the new vars.

---

## Removing a credential

1. Revoke the credential at the provider (delete token / rotate key / retire phone number).
2. Remove the vault item.
3. Remove the GitHub Actions secret (`gh secret delete ELIZA_E2E_…`).
4. Remove references from this doc and from the sweeper/rotation workflows.
5. Update any scenario `requires.credentials[]` that mentioned the identifier — or mark those scenarios `skip: retired-credential`.
