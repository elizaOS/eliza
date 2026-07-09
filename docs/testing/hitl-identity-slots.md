<!--
Identity-slot catalog for the LifeOps HITL connector matrix. The table is
checked by scripts/lifeops/connector-paths.test.mjs so operators can trust that
OWNER/AGENT slot docs match the registry that drives the dashboard and lane
preflight.
-->

# HITL Identity Slot Catalog

The LifeOps HITL matrix needs to know whether a credential represents the
OWNER, the AGENT, a runtime OAuth role, a separate real account, or a
slotless/shared credential. This table documents the current `CONNECTOR_PATHS`
contract for every auth path.

`n/a` means the path does not carry that slot through env vars. It does not mean
the connector never needs two real identities in a live lane; for OAuth-role and
separate-account rows the role is carried by the runtime login flow or by
separate account provisioning instead of by env key names.

| Path ID | Family | Kind | Slot model | OWNER env vars | AGENT env vars | Gate env vars | Notes |
|---|---|---|---|---|---|---|---|
| `model.openai-key` | model | api-key | single/slotless | n/a | n/a | OPENAI_API_KEY | n/a |
| `model.cerebras-key` | model | api-key | single/slotless | n/a | n/a | CEREBRAS_API_KEY | n/a |
| `model.anthropic-key` | model | api-key | single/slotless | n/a | n/a | ANTHROPIC_API_KEY | n/a |
| `elizacloud.siwe-session` | elizacloud | cloud-session | single/slotless | n/a | n/a | ELIZA_CLOUD_API_KEY<br>ELIZAOS_CLOUD_API_KEY | The session artifact is the API key, not the browser's steward_session_token JWT (that one only lives in dashboard localStorage). |
| `elizacloud.api-key` | elizacloud | api-key | single/slotless | n/a | n/a | ELIZA_CLOUD_API_KEY<br>ELIZAOS_CLOUD_API_KEY | n/a |
| `github.gh-cli` | github | cloud-session | single/slotless | n/a | n/a | GITHUB_TOKEN | n/a |
| `github.pat` | github | pat | env slots | GITHUB_USER_PAT<br>ELIZA_E2E_GITHUB_USER_PAT | GITHUB_AGENT_PAT<br>ELIZA_E2E_GITHUB_AGENT_PAT | GITHUB_USER_PAT<br>GITHUB_AGENT_PAT<br>GITHUB_TOKEN | OWNER label maps to plugin-github role 'user', AGENT to 'agent' (plugins/plugin-github/src/accounts.ts); GITHUB_ACCOUNTS JSON and character.settings.github.accounts are the multi-account forms; GITHUB_TOKEN stays the ownerless legacy single token. |
| `github.device-oauth` | github | user-oauth | single/slotless | n/a | n/a | GITHUB_OAUTH_CLIENT_ID | Device flow returns the consenting user's token into the legacy `GITHUB_TOKEN` slot; the OAuth app registration is owner-managed. |
| `github.user-oauth` | github | user-oauth | single/slotless | n/a | n/a | GITHUB_OAUTH_CLIENT_ID<br>GITHUB_OAUTH_CLIENT_SECRET<br>GITHUB_OAUTH_REDIRECT_URI | n/a |
| `google.oauth-owner` | google | user-oauth | OAuth requestedRole | n/a | n/a | GOOGLE_CLIENT_ID<br>GOOGLE_CLIENT_SECRET<br>GOOGLE_REDIRECT_URI | n/a |
| `google.oauth-agent` | google | user-oauth | OAuth requestedRole | n/a | n/a | GOOGLE_CLIENT_ID<br>GOOGLE_CLIENT_SECRET<br>GOOGLE_REDIRECT_URI | OWNER and AGENT are separate real Google accounts (owner-agent matrix doc §3); the role rides oauth start metadata (packages/core/src/connectors/oauth-role.ts), not env names. |
| `telegram.bot` | telegram | bot | single/slotless | n/a | n/a | TELEGRAM_BOT_TOKEN | n/a |
| `telegram.user-client` | telegram | user-client | single/slotless | n/a | n/a | TELEGRAM_API_ID<br>TELEGRAM_API_HASH<br>TELEGRAM_OWNER_SESSION<br>TELEGRAM_USER_SESSION | Documented ahead of a gramjs integration; TELEGRAM_OWNER_SESSION is the owner-scoped key required by the HITL issue, while TELEGRAM_USER_SESSION remains a temporary read alias. Telegram Desktop's tdata is proprietary/encrypted and is not a credential source. |
| `discord.bot` | discord | bot | single/slotless | n/a | n/a | DISCORD_API_TOKEN<br>DISCORD_BOT_TOKEN | n/a |
| `discord.user-token` | discord | user-client | single/slotless | n/a | n/a | DISCORD_USER_TOKEN | n/a |
| `discord.user-oauth` | discord | user-oauth | single/slotless | n/a | n/a | DISCORD_CLIENT_ID<br>DISCORD_CLIENT_SECRET | n/a |
| `slack.bot` | slack | bot | single/slotless | n/a | n/a | SLACK_BOT_TOKEN<br>SLACK_APP_TOKEN | n/a |
| `slack.user-token` | slack | user-client | single/slotless | n/a | n/a | SLACK_USER_TOKEN | n/a |
| `signal.desktop-bridge` | signal | local-bridge | single/slotless | n/a | n/a | n/a | n/a |
| `signal.cli` | signal | user-client | single/slotless | n/a | n/a | SIGNAL_ACCOUNT_NUMBER<br>SIGNAL_HTTP_URL<br>SIGNAL_CLI_PATH | Availability runs `--version` and the read-only `listAccounts`; the live probe also verifies the configured account is among the linked accounts. |
| `whatsapp.cloud-api` | whatsapp | api-key | single/slotless | n/a | n/a | ELIZA_WHATSAPP_ACCESS_TOKEN<br>ELIZA_WHATSAPP_PHONE_NUMBER_ID | ELIZA_WHATSAPP_* and bare WHATSAPP_* spellings are write-aliased by the dashboard; either satisfies the probe. |
| `imessage.macos` | imessage | local-bridge | single/slotless | n/a | n/a | n/a | n/a |
| `imessage.bluebubbles` | imessage | local-bridge | single/slotless | n/a | n/a | BLUEBUBBLES_SERVER_URL<br>BLUEBUBBLES_PASSWORD | An installed-but-stopped server is 'available' (row shows, probe reports connection refused with the start hint); the password lives in the server's config.db. |
| `x.oauth1-user` | x | user-oauth | single/slotless | n/a | n/a | TWITTER_API_KEY<br>TWITTER_API_SECRET_KEY<br>TWITTER_ACCESS_TOKEN<br>TWITTER_ACCESS_TOKEN_SECRET | n/a |
| `x.bearer-app` | x | api-key | single/slotless | n/a | n/a | TWITTER_BEARER_TOKEN | n/a |
| `x.agent-account` | x | user-oauth | separate real account | n/a | n/a | n/a | n/a |
| `twilio.api` | twilio | api-key | single/slotless | n/a | n/a | TWILIO_ACCOUNT_SID<br>TWILIO_AUTH_TOKEN | n/a |
| `health.strava` | health | api-key | single/slotless | n/a | n/a | STRAVA_ACCESS_TOKEN | n/a |
| `health.oura` | health | api-key | single/slotless | n/a | n/a | OURA_ACCESS_TOKEN | n/a |
| `health.fitbit` | health | api-key | single/slotless | n/a | n/a | FITBIT_ACCESS_TOKEN | n/a |
| `health.withings` | health | api-key | single/slotless | n/a | n/a | WITHINGS_ACCESS_TOKEN | n/a |
| `health.healthkit` | health | local-bridge | single/slotless | n/a | n/a | ELIZA_HEALTHKIT_CLI_PATH | n/a |
| `health.google-fit` | health | api-key | single/slotless | n/a | n/a | ELIZA_GOOGLE_FIT_ACCESS_TOKEN | n/a |
| `finance.plaid` | finance | api-key | single/slotless | n/a | n/a | PLAID_CLIENT_ID<br>PLAID_SECRET | n/a |
| `finance.paypal` | finance | api-key | single/slotless | n/a | n/a | PAYPAL_CLIENT_ID<br>PAYPAL_CLIENT_SECRET | LIFEOPS_FINANCE_CSV_FIXTURE remains the keyless finance alternative recognized by CONNECTOR_GROUPS; it is a fixture, not an auth path. |
| `crypto.evm` | crypto | api-key | single/slotless | n/a | n/a | EVM_PRIVATE_KEY | n/a |
| `crypto.solana` | crypto | api-key | single/slotless | n/a | n/a | SOLANA_PRIVATE_KEY | n/a |
