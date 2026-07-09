#!/usr/bin/env node
/**
 * Registry of every credential/auth path the LifeOps HITL intake surface can
 * offer per connector family (#11632). Where CONNECTOR_GROUPS (in
 * collect-11632-live-validation-status.mjs) answers "is this family ready",
 * CONNECTOR_PATHS answers "by which routes could it become ready": each entry
 * is one way to authenticate one family — bot token, user OAuth, local bridge,
 * PAT, cloud session, api key — with its env slots, its cheapest authenticated
 * probe, an optional one-click acquisition hint, and a declarative
 * availability check. Unavailable paths SKIP with a reason; they never error
 * and never hide.
 *
 * Owner/agent identity follows the two coexisting repo conventions instead of
 * inventing a third: (A) runtime-role families (Google, X, the
 * LIFEOPS_PERMISSION_MATRIX suites) carry roles via OAuth
 * metadata.requestedRole or separate real accounts with NO dedicated env
 * names — doc of record plugins/plugin-personal-assistant/docs/
 * owner-agent-validation-matrix.md §3; (B) GitHub is the one family with
 * concrete two-slot env names (plugins/plugin-github/src/accounts.ts):
 * OWNER -> role 'user' via GITHUB_USER_PAT (ELIZA_E2E_GITHUB_USER_PAT
 * fallback), AGENT -> role 'agent' via GITHUB_AGENT_PAT
 * (ELIZA_E2E_GITHUB_AGENT_PAT fallback), with plain GITHUB_TOKEN as the
 * ownerless legacy single-token key. Entries encode this via rolesVia +
 * ownerVars/agentVars.
 *
 * probeId values reference credential-probes.mjs families plus exactly two
 * registry-introduced ids ('github', 'elizacloud'); paths with no wired probe
 * carry probeId null but still document their free/cheap check in
 * probeEndpoint. Availability specs are data, evaluated by checkAvailability
 * with an injectable ctx so machine-state scenarios are unit-testable.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_FAMILIES } from "./credential-probes.mjs";

/** Path kinds — how the credential is obtained/held, not which provider. */
export const CONNECTOR_PATH_KINDS = [
  "bot",
  "user-oauth",
  "user-client",
  "local-bridge",
  "pat",
  "cloud-session",
  "api-key",
];

/** Probe ids valid on paths beyond the credential-probes.mjs family sweep. */
export const EXTRA_PROBE_IDS = ["github", "elizacloud", "imessage"];

export const DEFAULT_APP_BASE = "http://localhost:2138";

/** Dashboard/app base for deep links; mirrors the v1 dashboard's APP_BASE. */
export function appBase(env = process.env) {
  return env.ELIZA_APP_BASE_URL ?? DEFAULT_APP_BASE;
}

/** Resolve a deep-link oneClick's hrefPath against the app base, else null. */
export function resolveDeepLink(pathEntry, env = process.env) {
  const oneClick = pathEntry.oneClick;
  if (oneClick?.type !== "deep-link" || !oneClick.hrefPath) return null;
  return `${appBase(env)}${oneClick.hrefPath}`;
}

const ONE_CLICK_TYPES = ["gh-token", "deep-link", "shell", "siwe"];
const ROLES_VIA = [
  "env-slots",
  "oauth-requested-role",
  "separate-real-accounts",
];
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const CONNECTORS_SECTION_PATH = "/settings?section=connectors";

function definePath(entry) {
  return {
    group: null,
    requiredAll: [],
    requiredAny: [],
    optional: [],
    ownerVars: [],
    agentVars: [],
    rolesVia: null,
    oneClick: null,
    notes: null,
    ...entry,
  };
}

export const CONNECTOR_PATHS = [
  // --- model providers -------------------------------------------------------
  definePath({
    id: "model.openai-key",
    family: "model",
    group: "model",
    kind: "api-key",
    label: "OpenAI API key",
    requiredAll: ["OPENAI_API_KEY"],
    optional: ["OPENAI_BASE_URL"],
    probeId: "model",
    probeEndpoint:
      "GET {OPENAI_BASE_URL|https://api.openai.com/v1}/models (Bearer)",
    availability: { type: "always" },
  }),
  definePath({
    id: "model.cerebras-key",
    family: "model",
    group: "model",
    kind: "api-key",
    label: "Cerebras API key",
    requiredAll: ["CEREBRAS_API_KEY"],
    probeId: "model",
    probeEndpoint: "GET https://api.cerebras.ai/v1/models (Bearer)",
    availability: { type: "always" },
  }),
  definePath({
    id: "model.anthropic-key",
    family: "model",
    group: "model",
    kind: "api-key",
    label: "Anthropic API key",
    requiredAll: ["ANTHROPIC_API_KEY"],
    probeId: "model",
    probeEndpoint: "GET https://api.anthropic.com/v1/models (x-api-key)",
    availability: { type: "always" },
  }),

  // --- Eliza Cloud ------------------------------------------------------------
  definePath({
    id: "elizacloud.siwe-session",
    family: "elizacloud",
    kind: "cloud-session",
    label: "Eliza Cloud session via headless SIWE",
    requiredAny: ["ELIZA_CLOUD_API_KEY", "ELIZAOS_CLOUD_API_KEY"],
    optional: ["PRIVATE_KEY", "SIWE_BASE"],
    probeId: "elizacloud",
    probeEndpoint:
      "GET {SIWE_BASE|https://api.elizacloud.ai}/api/v1/credits/balance (Bearer apiKey)",
    oneClick: {
      type: "siwe",
      detail:
        "bun run cloud:login:test-wallet [--json] — SIWE nonce/sign/verify returns an apiKey (Bearer); PRIVATE_KEY pins the wallet, SIWE_BASE overrides the API base",
    },
    availability: { type: "always" },
    notes:
      "The session artifact is the API key, not the browser's steward_session_token JWT (that one only lives in dashboard localStorage).",
  }),
  definePath({
    id: "elizacloud.api-key",
    family: "elizacloud",
    kind: "api-key",
    label: "Eliza Cloud API key paste",
    requiredAny: ["ELIZA_CLOUD_API_KEY", "ELIZAOS_CLOUD_API_KEY"],
    optional: ["SIWE_BASE"],
    probeId: "elizacloud",
    probeEndpoint:
      "GET {SIWE_BASE|https://api.elizacloud.ai}/api/v1/credits/balance (Bearer apiKey)",
    availability: { type: "always" },
  }),

  // --- GitHub -----------------------------------------------------------------
  definePath({
    id: "github.gh-cli",
    family: "github",
    kind: "cloud-session",
    label: "Reuse gh CLI keyring token",
    requiredAny: ["GITHUB_TOKEN"],
    probeId: "github",
    probeEndpoint:
      "GET https://api.github.com/user (Authorization: Bearer <token>)",
    oneClick: {
      type: "gh-token",
      detail:
        "gh auth token — emits the keyring gho_ token; save it to GITHUB_TOKEN (ownerless legacy slot) or GITHUB_USER_PAT (owner slot)",
    },
    availability: {
      type: "all-of",
      specs: [
        {
          type: "command-in-path",
          command: "gh",
          reason: "gh CLI not in PATH",
        },
        {
          type: "command-ok",
          command: "gh",
          args: ["auth", "token"],
          reason: "gh CLI present but not authenticated (gh auth login)",
        },
      ],
    },
  }),
  definePath({
    id: "github.pat",
    family: "github",
    kind: "pat",
    label: "GitHub PATs (owner + agent slots)",
    requiredAny: ["GITHUB_USER_PAT", "GITHUB_AGENT_PAT", "GITHUB_TOKEN"],
    ownerVars: ["GITHUB_USER_PAT", "ELIZA_E2E_GITHUB_USER_PAT"],
    agentVars: ["GITHUB_AGENT_PAT", "ELIZA_E2E_GITHUB_AGENT_PAT"],
    rolesVia: "env-slots",
    probeId: "github",
    probeEndpoint:
      "GET https://api.github.com/user (Authorization: Bearer <token>)",
    availability: { type: "always" },
    notes:
      "OWNER label maps to plugin-github role 'user', AGENT to 'agent' (plugins/plugin-github/src/accounts.ts); GITHUB_ACCOUNTS JSON and character.settings.github.accounts are the multi-account forms; GITHUB_TOKEN stays the ownerless legacy single token.",
  }),
  definePath({
    id: "github.user-oauth",
    family: "github",
    kind: "user-oauth",
    label: "GitHub user OAuth app",
    requiredAll: [
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GITHUB_OAUTH_REDIRECT_URI",
    ],
    probeId: "github",
    probeEndpoint:
      "GET https://api.github.com/user (Authorization: Bearer <token>)",
    availability: {
      type: "env-all",
      names: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
      reason:
        "no OAuth app configured (GITHUB_OAUTH_CLIENT_ID/SECRET absent; no in-repo public client id exists for a local device-code flow)",
    },
  }),

  // --- Google (in-app OAuth consent; owner + agent are separate accounts) ------
  definePath({
    id: "google.oauth-owner",
    family: "google",
    group: "google",
    kind: "user-oauth",
    label: "Google OAuth — OWNER account",
    requiredAll: [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
    ],
    rolesVia: "oauth-requested-role",
    probeId: "google",
    probeEndpoint:
      "presence-only client credentials; live proof is POST /api/connectors/google/oauth/start (metadata.requestedRole=OWNER) then the consent flow",
    oneClick: {
      type: "deep-link",
      hrefPath: CONNECTORS_SECTION_PATH,
      detail:
        "Settings -> Connectors: connect the OWNER Google account (requestedRole=OWNER)",
    },
    availability: { type: "always" },
  }),
  definePath({
    id: "google.oauth-agent",
    family: "google",
    group: "google",
    kind: "user-oauth",
    label: "Google OAuth — AGENT account",
    requiredAll: [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
    ],
    rolesVia: "oauth-requested-role",
    probeId: "google",
    probeEndpoint:
      "presence-only client credentials; live proof is POST /api/connectors/google/oauth/start (metadata.requestedRole=AGENT) then the consent flow",
    oneClick: {
      type: "deep-link",
      hrefPath: CONNECTORS_SECTION_PATH,
      detail:
        "Settings -> Connectors: connect the AGENT Google account (requestedRole=AGENT)",
    },
    availability: { type: "always" },
    notes:
      "OWNER and AGENT are separate real Google accounts (owner-agent matrix doc §3); the role rides oauth start metadata (packages/core/src/connectors/oauth-role.ts), not env names.",
  }),

  // --- Telegram -----------------------------------------------------------------
  definePath({
    id: "telegram.bot",
    family: "telegram",
    group: "telegram",
    kind: "bot",
    label: "Telegram bot token",
    requiredAll: ["TELEGRAM_BOT_TOKEN"],
    optional: ["TELEGRAM_TEST_CHAT_ID", "TELEGRAM_ALLOWED_CHATS"],
    probeId: "telegram",
    probeEndpoint: "GET https://api.telegram.org/bot<token>/getMe",
    availability: { type: "always" },
  }),
  definePath({
    id: "telegram.user-client",
    family: "telegram",
    group: "telegram",
    kind: "user-client",
    label: "Telegram user client (future gramjs)",
    requiredAll: ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"],
    requiredAny: ["TELEGRAM_OWNER_SESSION", "TELEGRAM_USER_SESSION"],
    probeId: null,
    probeEndpoint:
      "gramjs getMe over the string session (not yet wired in-repo)",
    availability: {
      type: "any-of",
      specs: [
        {
          type: "env-present",
          names: ["TELEGRAM_OWNER_SESSION", "TELEGRAM_USER_SESSION"],
          reason:
            "no owner gramjs string session in env (TELEGRAM_OWNER_SESSION)",
        },
        {
          type: "file-exists",
          path: "~/.eliza/telegram-user.session",
          reason: "no saved session file (~/.eliza/telegram-user.session)",
        },
      ],
    },
    notes:
      "Documented ahead of a gramjs integration; TELEGRAM_OWNER_SESSION is the owner-scoped key required by the HITL issue, while TELEGRAM_USER_SESSION remains a temporary read alias. Telegram Desktop's tdata is proprietary/encrypted and is not a credential source.",
  }),

  // --- Discord --------------------------------------------------------------------
  definePath({
    id: "discord.bot",
    family: "discord",
    group: "discord",
    kind: "bot",
    label: "Discord bot token",
    requiredAny: ["DISCORD_API_TOKEN", "DISCORD_BOT_TOKEN"],
    probeId: "discord",
    probeEndpoint:
      "GET https://discord.com/api/v10/users/@me (Authorization: Bot <token>)",
    availability: { type: "always" },
  }),
  definePath({
    id: "discord.user-token",
    family: "discord",
    group: "discord",
    kind: "user-client",
    label: "Discord user token paste",
    requiredAll: ["DISCORD_USER_TOKEN"],
    probeId: "discord",
    probeEndpoint:
      "GET https://discord.com/api/v10/users/@me (raw user token, no Bot prefix)",
    availability: { type: "always" },
  }),
  definePath({
    id: "discord.user-oauth",
    family: "discord",
    group: "discord",
    kind: "user-oauth",
    label: "Discord user OAuth app",
    requiredAll: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
    probeId: null,
    probeEndpoint:
      "POST https://discord.com/api/oauth2/token then GET /users/@me",
    availability: {
      type: "env-all",
      names: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
      reason:
        "no Discord user-OAuth app configured (the in-tree exchange at packages/app-core/src/api/auth/discord-exchange.ts is Activity-iframe-only)",
    },
  }),

  // --- Slack ------------------------------------------------------------------------
  definePath({
    id: "slack.bot",
    family: "slack",
    group: "slack",
    kind: "bot",
    label: "Slack bot + app tokens",
    requiredAll: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    optional: ["SLACK_CHANNEL_IDS", "SLACK_SIGNING_SECRET"],
    probeId: "slack",
    probeEndpoint:
      "POST https://slack.com/api/auth.test (xoxb) + apps.connections.open (xapp)",
    availability: { type: "always" },
  }),
  definePath({
    id: "slack.user-token",
    family: "slack",
    group: "slack",
    kind: "user-client",
    label: "Slack user token (user-context calls)",
    requiredAll: ["SLACK_USER_TOKEN"],
    probeId: "slack",
    probeEndpoint: "POST https://slack.com/api/auth.test (xoxp user token)",
    availability: { type: "always" },
  }),

  // --- Signal --------------------------------------------------------------------------
  definePath({
    id: "signal.desktop-bridge",
    family: "signal",
    group: "signal",
    kind: "local-bridge",
    label: "Signal Desktop (status only)",
    probeId: null,
    probeEndpoint:
      "local install/link status only — Signal Desktop's DB is SQLCipher-encrypted and is not a credential source",
    availability: {
      type: "any-of",
      specs: [
        {
          type: "dir-exists",
          path: "/Applications/Signal.app",
          reason: "Signal Desktop not installed",
        },
        {
          type: "dir-exists",
          path: "~/Library/Application Support/Signal",
          reason: "no Signal Desktop profile directory",
        },
      ],
    },
  }),
  definePath({
    id: "signal.cli",
    family: "signal",
    group: "signal",
    kind: "user-client",
    label: "signal-cli / signal-cli-rest-api",
    requiredAll: ["SIGNAL_ACCOUNT_NUMBER"],
    requiredAny: ["SIGNAL_HTTP_URL", "SIGNAL_CLI_PATH"],
    probeId: "signal",
    probeEndpoint: "GET {SIGNAL_HTTP_URL}/v1/about, else signal-cli --version",
    oneClick: {
      type: "shell",
      detail:
        "signal-cli link -n eliza-hitl-dashboard — emits an sgnl://linkdevice URI to scan from the phone (Signal → Settings → Linked devices → Link new device)",
    },
    availability: {
      type: "any-of",
      specs: [
        {
          type: "env-present",
          names: ["SIGNAL_HTTP_URL"],
          reason: "no signal-cli-rest-api URL",
        },
        {
          type: "all-of",
          specs: [
            {
              type: "command-in-path",
              command: "signal-cli",
              reason: "signal-cli not in PATH",
            },
            {
              type: "dir-exists",
              path: "~/.local/share/signal-cli",
              reason:
                "no registered signal-cli account (~/.local/share/signal-cli missing)",
            },
          ],
        },
      ],
    },
    notes:
      "A signal-cli binary can be present but unrunnable (e.g. built for a newer JRE); the data-dir requirement keeps an unregistered install skipping instead of red.",
  }),

  // --- WhatsApp -----------------------------------------------------------------------
  definePath({
    id: "whatsapp.cloud-api",
    family: "whatsapp",
    group: "whatsapp",
    kind: "api-key",
    label: "WhatsApp Cloud API token + phone id",
    requiredAll: [
      "ELIZA_WHATSAPP_ACCESS_TOKEN",
      "ELIZA_WHATSAPP_PHONE_NUMBER_ID",
    ],
    optional: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
    probeId: "whatsapp",
    probeEndpoint:
      "GET https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}?fields=display_phone_number (Bearer)",
    availability: { type: "always" },
    notes:
      "ELIZA_WHATSAPP_* and bare WHATSAPP_* spellings are write-aliased by the dashboard; either satisfies the probe.",
  }),

  // --- iMessage ------------------------------------------------------------------------
  definePath({
    id: "imessage.macos",
    family: "imessage",
    group: "native_ios_macos",
    kind: "local-bridge",
    label: "macOS Messages bridge",
    optional: ["ELIZA_IMESSAGE_BACKEND"],
    probeId: "imessage",
    probeEndpoint:
      "local: ~/Library/Messages/chat.db readable (requires Full Disk Access)",
    availability: {
      type: "all-of",
      specs: [
        { type: "platform", platform: "darwin", reason: "not macOS" },
        {
          type: "any-of",
          specs: [
            {
              type: "env-present",
              names: ["ELIZA_IMESSAGE_BACKEND"],
              reason: "no iMessage backend configured",
            },
            {
              type: "file-exists",
              path: "~/Library/Messages/chat.db",
              reason: "Messages database not readable (grant Full Disk Access)",
            },
          ],
        },
      ],
    },
  }),
  definePath({
    id: "imessage.bluebubbles",
    family: "imessage",
    group: "native_ios_macos",
    kind: "local-bridge",
    label: "BlueBubbles server",
    requiredAll: ["BLUEBUBBLES_SERVER_URL", "BLUEBUBBLES_PASSWORD"],
    probeId: "imessage",
    probeEndpoint:
      "GET {BLUEBUBBLES_SERVER_URL|http://localhost:1234}/api/v1/ping?password=<password>",
    availability: {
      type: "any-of",
      specs: [
        {
          type: "env-all",
          names: ["BLUEBUBBLES_SERVER_URL", "BLUEBUBBLES_PASSWORD"],
          reason: "BlueBubbles server URL/password not configured",
        },
        {
          type: "dir-exists",
          path: "~/Library/Application Support/bluebubbles-server",
          reason: "no BlueBubbles server profile",
        },
        {
          type: "dir-exists",
          path: "/Applications/BlueBubbles.app",
          reason: "BlueBubbles not installed",
        },
      ],
    },
    notes:
      "An installed-but-stopped server is 'available' (row shows, probe reports connection refused with the start hint); the password lives in the server's config.db.",
  }),

  // --- X ---------------------------------------------------------------------------------
  definePath({
    id: "x.oauth1-user",
    family: "x",
    group: "x",
    kind: "user-oauth",
    label: "X OAuth1 user context (owner account)",
    requiredAll: [
      "TWITTER_API_KEY",
      "TWITTER_API_SECRET_KEY",
      "TWITTER_ACCESS_TOKEN",
      "TWITTER_ACCESS_TOKEN_SECRET",
    ],
    optional: ["X_API_KEY"],
    probeId: "x",
    probeEndpoint: "GET https://api.x.com/2/users/me (OAuth1 HMAC-SHA1 signed)",
    availability: { type: "always" },
  }),
  definePath({
    id: "x.bearer-app",
    family: "x",
    group: "x",
    kind: "api-key",
    label: "X app-only bearer token",
    requiredAll: ["TWITTER_BEARER_TOKEN"],
    probeId: "x",
    probeEndpoint:
      "GET https://api.x.com/2/users/me (Bearer; app-only cannot read user context — a valid key authenticates but is told so, an invalid key gets 401)",
    availability: { type: "always" },
  }),
  definePath({
    id: "x.agent-account",
    family: "x",
    group: "x",
    kind: "user-oauth",
    label: "X AGENT account (separate real account)",
    rolesVia: "separate-real-accounts",
    probeId: null,
    probeEndpoint:
      "GET https://api.x.com/2/users/me with the agent account's own OAuth1 tokens",
    availability: {
      type: "never",
      reason:
        "agent X identity is a separate real account per the owner-agent matrix doc §3 — no dedicated env slots exist; connect it as its own account when the matrix lane needs it",
    },
  }),

  // --- Twilio -------------------------------------------------------------------------------
  definePath({
    id: "twilio.api",
    family: "twilio",
    group: "twilio",
    kind: "api-key",
    label: "Twilio account SID + auth token",
    requiredAll: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    optional: ["TWILIO_PHONE_NUMBER", "TWILIO_WEBHOOK_URL"],
    probeId: "twilio",
    probeEndpoint:
      "GET https://api.twilio.com/2010-04-01/Accounts/{SID}.json (Basic)",
    availability: { type: "always" },
  }),

  // --- Health --------------------------------------------------------------------------------
  definePath({
    id: "health.strava",
    family: "health",
    group: "health",
    kind: "api-key",
    label: "Strava access token",
    requiredAll: ["STRAVA_ACCESS_TOKEN"],
    probeId: "health",
    probeEndpoint: "GET https://www.strava.com/api/v3/athlete (Bearer)",
    oneClick: {
      type: "deep-link",
      hrefPath: CONNECTORS_SECTION_PATH,
      detail: "Settings -> Connectors: Strava OAuth consent",
    },
    availability: { type: "always" },
  }),
  definePath({
    id: "health.oura",
    family: "health",
    group: "health",
    kind: "api-key",
    label: "Oura access token",
    requiredAll: ["OURA_ACCESS_TOKEN"],
    probeId: "health",
    probeEndpoint:
      "GET https://api.ouraring.com/v2/usercollection/personal_info (Bearer)",
    oneClick: {
      type: "deep-link",
      hrefPath: CONNECTORS_SECTION_PATH,
      detail: "Settings -> Connectors: Oura OAuth consent",
    },
    availability: { type: "always" },
  }),
  definePath({
    id: "health.fitbit",
    family: "health",
    group: "health",
    kind: "api-key",
    label: "Fitbit access token",
    requiredAll: ["FITBIT_ACCESS_TOKEN"],
    probeId: "health",
    probeEndpoint: "GET https://api.fitbit.com/1/user/-/profile.json (Bearer)",
    oneClick: {
      type: "deep-link",
      hrefPath: CONNECTORS_SECTION_PATH,
      detail: "Settings -> Connectors: Fitbit OAuth consent",
    },
    availability: { type: "always" },
  }),
  definePath({
    id: "health.withings",
    family: "health",
    group: "health",
    kind: "api-key",
    label: "Withings access token",
    requiredAll: ["WITHINGS_ACCESS_TOKEN"],
    probeId: "health",
    probeEndpoint:
      "GET https://wbsapi.withings.net/v2/user?action=getdevice (Bearer)",
    oneClick: {
      type: "deep-link",
      hrefPath: CONNECTORS_SECTION_PATH,
      detail: "Settings -> Connectors: Withings OAuth consent",
    },
    availability: { type: "always" },
  }),
  definePath({
    id: "health.healthkit",
    family: "health",
    group: "health",
    kind: "local-bridge",
    label: "HealthKit export CLI (device-local)",
    requiredAll: ["ELIZA_HEALTHKIT_CLI_PATH"],
    probeId: null,
    probeEndpoint:
      "local: the ELIZA_HEALTHKIT_CLI_PATH binary responds on-device",
    availability: {
      type: "all-of",
      specs: [
        {
          type: "platform",
          platform: "darwin",
          reason: "HealthKit is Apple-only",
        },
        {
          type: "env-present",
          names: ["ELIZA_HEALTHKIT_CLI_PATH"],
          reason: "no HealthKit CLI configured",
        },
      ],
    },
  }),
  definePath({
    id: "health.google-fit",
    family: "health",
    group: "health",
    kind: "api-key",
    label: "Google Fit access token",
    requiredAll: ["ELIZA_GOOGLE_FIT_ACCESS_TOKEN"],
    probeId: "health",
    probeEndpoint:
      "GET https://www.googleapis.com/fitness/v1/users/me/dataSources (Bearer)",
    availability: { type: "always" },
  }),

  // --- Finance --------------------------------------------------------------------------------
  definePath({
    id: "finance.plaid",
    family: "finance",
    group: "finance",
    kind: "api-key",
    label: "Plaid sandbox credentials",
    requiredAll: ["PLAID_CLIENT_ID", "PLAID_SECRET"],
    probeId: "plaid",
    probeEndpoint: "POST https://sandbox.plaid.com/institutions/get",
    availability: { type: "always" },
  }),
  definePath({
    id: "finance.paypal",
    family: "finance",
    group: "finance",
    kind: "api-key",
    label: "PayPal sandbox credentials",
    requiredAll: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"],
    optional: ["PAYPAL_API_BASE"],
    probeId: "paypal",
    probeEndpoint:
      "POST {PAYPAL_API_BASE|https://api-m.sandbox.paypal.com}/v1/oauth2/token (Basic, client_credentials)",
    availability: { type: "always" },
    notes:
      "LIFEOPS_FINANCE_CSV_FIXTURE remains the keyless finance alternative recognized by CONNECTOR_GROUPS; it is a fixture, not an auth path.",
  }),

  // --- Crypto ---------------------------------------------------------------------------------
  definePath({
    id: "crypto.evm",
    family: "crypto",
    kind: "api-key",
    label: "EVM private key",
    requiredAll: ["EVM_PRIVATE_KEY"],
    probeId: null,
    probeEndpoint:
      "local key parse -> address, then eth_getBalance via a public RPC (free, read-only)",
    availability: { type: "always" },
  }),
  definePath({
    id: "crypto.solana",
    family: "crypto",
    kind: "api-key",
    label: "Solana private key",
    requiredAll: ["SOLANA_PRIVATE_KEY"],
    probeId: null,
    probeEndpoint:
      "local key parse -> address, then getBalance via a public RPC (free, read-only)",
    availability: { type: "always" },
  }),
].map(Object.freeze);

/** All env names any path can read — the dashboard's save-allowlist extension. */
export const CONNECTOR_PATH_ENV_NAMES = new Set(
  CONNECTOR_PATHS.flatMap((path) => [
    ...path.requiredAll,
    ...path.requiredAny,
    ...path.optional,
    ...path.ownerVars,
    ...path.agentVars,
  ]),
);

export function getFamilies(paths = CONNECTOR_PATHS) {
  return [...new Set(paths.map((path) => path.family))];
}

export function getPathsForFamily(family, paths = CONNECTOR_PATHS) {
  return paths.filter((path) => path.family === family);
}

// --- availability evaluation ---------------------------------------------------

function hasEnv(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function expandHome(path, home) {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function commandInPath(command) {
  const pathValue = process.env.PATH ?? "";
  return pathValue
    .split(delimiter)
    .some((dir) => dir.length > 0 && existsSync(join(dir, command)));
}

/** Real-machine evaluation context; every field is injectable in tests. */
export function defaultAvailabilityCtx() {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    existsSync,
    commandInPath,
    runCommand: (command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 10_000,
      });
      return { ok: !result.error && result.status === 0 };
    },
  };
}

/**
 * Evaluate a declarative availability spec to { available, reason }. Leaf
 * failures surface their spec's reason; any-of joins all branch reasons,
 * all-of reports the first failing requirement. Unknown spec types throw —
 * a malformed registry entry is a bug, not a skip.
 */
export function checkAvailability(spec, ctx = defaultAvailabilityCtx()) {
  const ok = { available: true, reason: null };
  switch (spec.type) {
    case "always":
      return ok;
    case "never":
      return { available: false, reason: spec.reason };
    case "env-present":
    case "env-any":
      return spec.names.some((name) => hasEnv(ctx.env, name))
        ? ok
        : {
            available: false,
            reason: spec.reason ?? `none of ${spec.names.join(", ")} set`,
          };
    case "env-all":
      return spec.names.every((name) => hasEnv(ctx.env, name))
        ? ok
        : {
            available: false,
            reason:
              spec.reason ??
              `missing ${spec.names.filter((name) => !hasEnv(ctx.env, name)).join(", ")}`,
          };
    case "dir-exists":
    case "file-exists":
      return ctx.existsSync(expandHome(spec.path, ctx.home))
        ? ok
        : { available: false, reason: spec.reason ?? `${spec.path} missing` };
    case "command-in-path":
      return ctx.commandInPath(spec.command)
        ? ok
        : {
            available: false,
            reason: spec.reason ?? `${spec.command} not in PATH`,
          };
    case "command-ok":
      return ctx.runCommand(spec.command, spec.args).ok
        ? ok
        : {
            available: false,
            reason:
              spec.reason ?? `${spec.command} ${spec.args.join(" ")} failed`,
          };
    case "platform":
      return ctx.platform === spec.platform
        ? ok
        : {
            available: false,
            reason: spec.reason ?? `requires ${spec.platform}`,
          };
    case "any-of": {
      const results = spec.specs.map((inner) => checkAvailability(inner, ctx));
      const hit = results.find((result) => result.available);
      return (
        hit ?? {
          available: false,
          reason: results.map((r) => r.reason).join("; "),
        }
      );
    }
    case "all-of": {
      for (const inner of spec.specs) {
        const result = checkAvailability(inner, ctx);
        if (!result.available) return result;
      }
      return ok;
    }
    default:
      throw new Error(
        `Unknown availability spec type: ${JSON.stringify(spec.type)}`,
      );
  }
}

/**
 * Evaluate every path's availability. Rows carry env NAMES and metadata only —
 * never env values — so the result is safe to serialize into a dashboard
 * payload or a committed ledger.
 */
export function evaluateConnectorPaths(
  ctx = defaultAvailabilityCtx(),
  paths = CONNECTOR_PATHS,
) {
  return paths.map((path) => {
    const { available, reason } = checkAvailability(path.availability, ctx);
    return {
      id: path.id,
      family: path.family,
      group: path.group,
      kind: path.kind,
      label: path.label,
      requiredAll: path.requiredAll,
      requiredAny: path.requiredAny,
      optional: path.optional,
      ownerVars: path.ownerVars,
      agentVars: path.agentVars,
      rolesVia: path.rolesVia,
      probeId: path.probeId,
      probeEndpoint: path.probeEndpoint,
      oneClick: path.oneClick,
      notes: path.notes,
      available,
      reason,
    };
  });
}

// --- registry invariants ---------------------------------------------------------

const VALID_PROBE_IDS = new Set([...PROBE_FAMILIES, ...EXTRA_PROBE_IDS]);

function validateAvailabilitySpec(spec, id, problems) {
  if (!spec || typeof spec.type !== "string") {
    problems.push(`${id}: availability spec missing type`);
    return;
  }
  if (spec.type === "any-of" || spec.type === "all-of") {
    if (!Array.isArray(spec.specs) || spec.specs.length === 0) {
      problems.push(`${id}: ${spec.type} needs a non-empty specs array`);
      return;
    }
    for (const inner of spec.specs)
      validateAvailabilitySpec(inner, id, problems);
    return;
  }
  const known = [
    "always",
    "never",
    "env-present",
    "env-any",
    "env-all",
    "dir-exists",
    "file-exists",
    "command-in-path",
    "command-ok",
    "platform",
  ];
  if (!known.includes(spec.type)) {
    problems.push(`${id}: unknown availability type ${spec.type}`);
  }
  if (spec.type === "never" && !spec.reason) {
    problems.push(`${id}: never spec must carry a reason`);
  }
}

/**
 * Structural invariants for a paths array; returns problem strings (empty =
 * valid). Enforced at import time for the shipped registry so a malformed
 * entry fails fast instead of silently mis-rendering.
 */
export function validateConnectorPaths(paths = CONNECTOR_PATHS) {
  const problems = [];
  const seen = new Set();
  for (const path of paths) {
    if (seen.has(path.id)) problems.push(`duplicate id: ${path.id}`);
    seen.add(path.id);
    if (!path.id.startsWith(`${path.family}.`)) {
      problems.push(`${path.id}: id must be <family>.<slug>`);
    }
    if (!CONNECTOR_PATH_KINDS.includes(path.kind)) {
      problems.push(`${path.id}: invalid kind ${path.kind}`);
    }
    if (typeof path.label !== "string" || path.label.length === 0) {
      problems.push(`${path.id}: missing label`);
    }
    if (path.probeId !== null && !VALID_PROBE_IDS.has(path.probeId)) {
      problems.push(`${path.id}: unknown probeId ${path.probeId}`);
    }
    if (
      typeof path.probeEndpoint !== "string" ||
      path.probeEndpoint.length === 0
    ) {
      problems.push(
        `${path.id}: every path must name its free/cheap probe endpoint`,
      );
    }
    if (
      path.oneClick !== null &&
      !ONE_CLICK_TYPES.includes(path.oneClick.type)
    ) {
      problems.push(`${path.id}: invalid oneClick type ${path.oneClick?.type}`);
    }
    if (path.rolesVia !== null && !ROLES_VIA.includes(path.rolesVia)) {
      problems.push(`${path.id}: invalid rolesVia ${path.rolesVia}`);
    }
    if (
      (path.ownerVars.length > 0 || path.agentVars.length > 0) &&
      path.rolesVia !== "env-slots"
    ) {
      problems.push(`${path.id}: ownerVars/agentVars imply rolesVia env-slots`);
    }
    for (const name of [
      ...path.requiredAll,
      ...path.requiredAny,
      ...path.optional,
      ...path.ownerVars,
      ...path.agentVars,
    ]) {
      if (!ENV_NAME_PATTERN.test(name)) {
        problems.push(`${path.id}: malformed env name ${name}`);
      }
    }
    validateAvailabilitySpec(path.availability, path.id, problems);
  }
  return problems;
}

{
  const problems = validateConnectorPaths(CONNECTOR_PATHS);
  if (problems.length > 0) {
    throw new Error(
      `connector-paths registry invalid:\n${problems.join("\n")}`,
    );
  }
}

// --- CLI: evaluate availability on this machine (no secrets printed) -------------

const IS_MAIN =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const rows = evaluateConnectorPaths();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const row of rows) {
      const mark = row.available ? "avail" : "skip ";
      console.log(
        `${mark} ${row.id.padEnd(24)} ${row.kind.padEnd(13)} ${row.reason ?? ""}`,
      );
    }
    console.log(`\n${rows.length} paths, ${getFamilies().length} families`);
  }
}
