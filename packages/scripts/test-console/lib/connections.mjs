/**
 * Connection catalog for the local test console: every credentialed service
 * the repo's live/guarded test suites can consume, described as data.
 *
 * Each connection declares the env vars it provides (`fields`), where a human
 * obtains the credential (`obtain`), and a cheap read-only HTTP probe
 * (`verify`) the console runs to prove a saved credential actually works
 * before any test depends on it. Gating is derived, not hand-mapped: a suite
 * from GUARDED_REAL_LIVE_SUITES is enabled when every env var it `requires`
 * is provided by some configured connection (or the ambient environment), so
 * the catalog only has to keep var→connection ownership complete —
 * __tests__/connections-coverage.test.ts enforces that mechanically against
 * the manifest and packages/scripts/post-merge-secrets.txt.
 *
 * Verify probes are data, not code: `{ kind: "http", url, method?, headers?,
 * body?, okStatus? }` with `{{VAR}}` placeholders substituted from the saved
 * values. `kind: "format"` just pattern-checks locally (private keys we must
 * never send anywhere); `kind: "none"` means the credential is only provable
 * by running its suite.
 */

/** Deliberate operator opt-in gates (destructive/heavy suites). The console
 * surfaces these as toggles, never auto-arms them. */
export const OPT_IN_GATES = [
  { key: "ELIZA_RUN_LIVE_TESTS", label: "Live model tests (core)" },
  { key: "ELIZA_LIVE_EVM_RPC_TEST", label: "Live EVM RPC tests" },
  { key: "ELIZA_LIVE_APPLE_REMINDERS_TEST", label: "Apple Reminders (macOS)" },
  {
    key: "ORCHESTRATOR_LIVE_MULTI_ACCOUNT",
    label: "Orchestrator multi-account",
  },
  { key: "RUN_LIVE_NATIVE_ACP", label: "Native ACP smoke" },
  { key: "RUN_LIVE_ACPX", label: "ACPX sub-agent router" },
  { key: "FORCE_OSWORLD_BENCHMARK", label: "OSWorld benchmark" },
];

export const CONNECTIONS = [
  // --- LLM providers -------------------------------------------------------
  {
    id: "openai",
    label: "OpenAI",
    category: "llm",
    kind: "api-key",
    obtain: "https://platform.openai.com/api-keys",
    fields: [
      { key: "OPENAI_API_KEY", label: "API key", secret: true, required: true },
      {
        key: "OPENAI_API_KEY_REAL",
        label: "Real-drift API key (optional; defaults to API key)",
        secret: true,
        required: false,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: "Bearer {{OPENAI_API_KEY}}" },
    },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    category: "llm",
    kind: "api-key",
    obtain: "https://console.anthropic.com/settings/keys",
    fields: [
      {
        key: "ANTHROPIC_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.anthropic.com/v1/models",
      headers: {
        "x-api-key": "{{ANTHROPIC_API_KEY}}",
        "anthropic-version": "2023-06-01",
      },
    },
  },
  {
    id: "cerebras",
    label: "Cerebras",
    category: "llm",
    kind: "api-key",
    obtain: "https://cloud.cerebras.ai/",
    fields: [
      {
        key: "CEREBRAS_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.cerebras.ai/v1/models",
      headers: { Authorization: "Bearer {{CEREBRAS_API_KEY}}" },
    },
  },
  {
    id: "groq",
    label: "Groq",
    category: "llm",
    kind: "api-key",
    obtain: "https://console.groq.com/keys",
    fields: [
      { key: "GROQ_API_KEY", label: "API key", secret: true, required: true },
    ],
    verify: {
      kind: "http",
      url: "https://api.groq.com/openai/v1/models",
      headers: { Authorization: "Bearer {{GROQ_API_KEY}}" },
    },
  },
  {
    id: "google-genai",
    label: "Google Generative AI",
    category: "llm",
    kind: "api-key",
    obtain: "https://aistudio.google.com/apikey",
    fields: [
      {
        key: "GOOGLE_GENERATIVE_AI_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://generativelanguage.googleapis.com/v1beta/models?key={{GOOGLE_GENERATIVE_AI_API_KEY}}",
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    category: "llm",
    kind: "api-key",
    obtain: "https://openrouter.ai/settings/keys",
    fields: [
      {
        key: "OPENROUTER_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://openrouter.ai/api/v1/key",
      headers: { Authorization: "Bearer {{OPENROUTER_API_KEY}}" },
    },
  },
  {
    id: "xai",
    label: "xAI",
    category: "llm",
    kind: "api-key",
    obtain: "https://console.x.ai/",
    fields: [
      { key: "XAI_API_KEY", label: "API key", secret: true, required: true },
    ],
    verify: {
      kind: "http",
      url: "https://api.x.ai/v1/models",
      headers: { Authorization: "Bearer {{XAI_API_KEY}}" },
    },
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    category: "llm",
    kind: "api-key",
    obtain: "https://elevenlabs.io/app/settings/api-keys",
    fields: [
      {
        key: "ELEVENLABS_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.elevenlabs.io/v1/user",
      headers: { "xi-api-key": "{{ELEVENLABS_API_KEY}}" },
    },
  },
  {
    id: "atlascloud",
    label: "AtlasCloud (media generation)",
    category: "llm",
    kind: "api-key",
    obtain: "https://www.atlascloud.ai/",
    fields: [
      {
        key: "ATLASCLOUD_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: { kind: "none" },
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    category: "llm",
    kind: "endpoint",
    obtain: "https://ollama.com/download — then `ollama serve`",
    fields: [
      {
        key: "OLLAMA_API_ENDPOINT",
        label: "API endpoint",
        secret: false,
        required: true,
        placeholder: "http://127.0.0.1:11434",
      },
    ],
    verify: { kind: "http", url: "{{OLLAMA_API_ENDPOINT}}/api/tags" },
  },

  // --- Messaging connectors ------------------------------------------------
  {
    id: "discord",
    label: "Discord",
    category: "messaging",
    kind: "token",
    obtain:
      "https://discord.com/developers/applications — bot token; invite the bot to a throwaway test guild",
    fields: [
      {
        key: "DISCORD_BOT_TOKEN",
        label: "Bot token",
        secret: true,
        required: true,
      },
      {
        key: "DISCORD_TEST_GUILD_ID",
        label: "Test guild ID",
        secret: false,
        required: true,
      },
      {
        key: "DISCORD_API_TOKEN",
        label: "Runtime bot token (optional; defaults to bot token)",
        secret: true,
        required: false,
      },
      {
        key: "DISCORD_APPLICATION_ID",
        label: "Application ID (optional)",
        secret: false,
        required: false,
      },
    ],
    verify: {
      kind: "http",
      url: "https://discord.com/api/v10/users/@me",
      headers: { Authorization: "Bot {{DISCORD_BOT_TOKEN}}" },
    },
  },
  {
    id: "telegram",
    label: "Telegram",
    category: "messaging",
    kind: "token",
    obtain: "https://t.me/BotFather — create a bot; add it to a test chat",
    fields: [
      {
        key: "TELEGRAM_BOT_TOKEN",
        label: "Bot token",
        secret: true,
        required: true,
      },
      {
        key: "TELEGRAM_TEST_CHAT_ID",
        label: "Test chat ID",
        secret: false,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/getMe",
    },
  },
  {
    id: "slack",
    label: "Slack",
    category: "messaging",
    kind: "token",
    obtain:
      "https://api.slack.com/apps — bot token (xoxb-) with a test channel the app is in",
    fields: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot token (xoxb-)",
        secret: true,
        required: true,
      },
      {
        key: "SLACK_TEST_CHANNEL_ID",
        label: "Test channel ID",
        secret: false,
        required: true,
      },
      {
        key: "SLACK_APP_TOKEN",
        label: "App token (xapp-, Socket Mode; optional)",
        secret: true,
        required: false,
      },
    ],
    verify: {
      kind: "http",
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: { Authorization: "Bearer {{SLACK_BOT_TOKEN}}" },
      okBodyPattern: '"ok"\\s*:\\s*true',
    },
  },
  {
    id: "whatsapp",
    label: "WhatsApp (Cloud API)",
    category: "messaging",
    kind: "token",
    obtain:
      "https://developers.facebook.com/apps — WhatsApp Cloud API access token",
    fields: [
      {
        key: "WHATSAPP_TOKEN",
        label: "Access token",
        secret: true,
        required: true,
      },
      {
        key: "WHATSAPP_PHONE_NUMBER_ID",
        label: "Phone number ID",
        secret: false,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://graph.facebook.com/v19.0/{{WHATSAPP_PHONE_NUMBER_ID}}",
      headers: { Authorization: "Bearer {{WHATSAPP_TOKEN}}" },
    },
  },
  {
    id: "x",
    label: "X (Twitter)",
    category: "messaging",
    kind: "token",
    obtain: "https://developer.x.com/en/portal/dashboard — app bearer token",
    fields: [
      {
        key: "X_BEARER_TOKEN",
        label: "App bearer token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.x.com/2/users/by/username/x",
      headers: { Authorization: "Bearer {{X_BEARER_TOKEN}}" },
    },
  },
  {
    id: "bluesky",
    label: "Bluesky",
    category: "messaging",
    kind: "token",
    obtain: "https://bsky.app/settings/app-passwords",
    fields: [
      {
        key: "BLUESKY_HANDLE",
        label: "Handle",
        secret: false,
        required: false,
        placeholder: "example.bsky.social",
      },
      {
        key: "BLUESKY_PASSWORD",
        label: "App password",
        secret: true,
        required: true,
      },
    ],
    verify: { kind: "none" },
  },
  {
    id: "farcaster",
    label: "Farcaster (Neynar)",
    category: "messaging",
    kind: "api-key",
    obtain: "https://neynar.com/ — API key (+ signer for posting)",
    fields: [
      {
        key: "FARCASTER_NEYNAR_API_KEY",
        label: "Neynar API key",
        secret: true,
        required: true,
      },
      {
        key: "FARCASTER_FID",
        label: "FID (optional)",
        secret: false,
        required: false,
      },
      {
        key: "FARCASTER_SIGNER_UUID",
        label: "Signer UUID (optional)",
        secret: true,
        required: false,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.neynar.com/v2/farcaster/user/bulk?fids=3",
      headers: { "x-api-key": "{{FARCASTER_NEYNAR_API_KEY}}" },
    },
  },

  // --- SaaS ----------------------------------------------------------------
  {
    id: "github",
    label: "GitHub",
    category: "saas",
    kind: "token",
    obtain: "https://github.com/settings/tokens",
    fields: [
      {
        key: "GITHUB_TOKEN",
        label: "Personal access token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.github.com/rate_limit",
      headers: {
        Authorization: "Bearer {{GITHUB_TOKEN}}",
        "User-Agent": "eliza-test-console",
      },
    },
  },
  {
    id: "linear",
    label: "Linear",
    category: "saas",
    kind: "api-key",
    obtain: "https://linear.app/settings/api",
    fields: [
      { key: "LINEAR_API_KEY", label: "API key", secret: true, required: true },
    ],
    verify: {
      kind: "http",
      url: "https://api.linear.app/graphql",
      method: "POST",
      headers: {
        Authorization: "{{LINEAR_API_KEY}}",
        "Content-Type": "application/json",
      },
      body: '{"query":"{ viewer { id } }"}',
    },
  },
  {
    id: "calendly",
    label: "Calendly",
    category: "saas",
    kind: "token",
    obtain:
      "https://calendly.com/integrations/api_webhooks — personal access token",
    fields: [
      {
        key: "CALENDLY_ACCESS_TOKEN",
        label: "Personal access token",
        secret: true,
        required: true,
      },
      {
        key: "CALENDLY_API_KEY",
        label: "API key (legacy alias; optional)",
        secret: true,
        required: false,
      },
      {
        key: "ELIZA_E2E_CALENDLY_ACCESS_TOKEN",
        label: "Dedicated e2e token (optional; defaults to access token)",
        secret: true,
        required: false,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.calendly.com/users/me",
      headers: { Authorization: "Bearer {{CALENDLY_ACCESS_TOKEN}}" },
    },
  },
  {
    id: "twilio",
    label: "Twilio",
    category: "saas",
    kind: "api-key",
    obtain: "https://console.twilio.com/ — account SID + auth token",
    fields: [
      {
        key: "TWILIO_ACCOUNT_SID",
        label: "Account SID",
        secret: false,
        required: true,
      },
      {
        key: "TWILIO_AUTH_TOKEN",
        label: "Auth token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.twilio.com/2010-04-01/Accounts/{{TWILIO_ACCOUNT_SID}}.json",
      basicAuth: ["{{TWILIO_ACCOUNT_SID}}", "{{TWILIO_AUTH_TOKEN}}"],
    },
  },
  {
    id: "google-oauth",
    label: "Google OAuth (Workspace APIs)",
    category: "saas",
    kind: "oauth",
    obtain:
      "https://console.cloud.google.com/apis/credentials — OAuth client (Desktop); the console's Connect button mints the refresh token via loopback",
    oauth: "google",
    fields: [
      {
        key: "GOOGLE_CLIENT_ID",
        label: "OAuth client ID",
        secret: false,
        required: true,
      },
      {
        key: "GOOGLE_CLIENT_SECRET",
        label: "OAuth client secret",
        secret: true,
        required: true,
      },
      {
        key: "GOOGLE_OAUTH_REFRESH_TOKEN",
        label: "Refresh token (minted by Connect)",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id={{GOOGLE_CLIENT_ID}}&client_secret={{GOOGLE_CLIENT_SECRET}}&refresh_token={{GOOGLE_OAUTH_REFRESH_TOKEN}}&grant_type=refresh_token",
    },
  },
  {
    id: "google-calendar",
    label: "Google Calendar (access token)",
    category: "calendar",
    kind: "oauth",
    obtain:
      "Minted from the Google OAuth connection (Connect button) or paste a short-lived access token",
    oauth: "google-calendar",
    fields: [
      {
        key: "GOOGLE_CALENDAR_ACCESS_TOKEN",
        label: "Access token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
      headers: { Authorization: "Bearer {{GOOGLE_CALENDAR_ACCESS_TOKEN}}" },
    },
  },
  {
    id: "shopify",
    label: "Shopify",
    category: "saas",
    kind: "api-key",
    obtain: "https://admin.shopify.com/ — custom app admin API token",
    fields: [
      {
        key: "SHOPIFY_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: { kind: "none" },
  },
  {
    id: "tavily",
    label: "Tavily (web search)",
    category: "saas",
    kind: "api-key",
    obtain: "https://app.tavily.com/",
    fields: [
      { key: "TAVILY_API_KEY", label: "API key", secret: true, required: true },
    ],
    verify: {
      kind: "http",
      url: "https://api.tavily.com/search",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"api_key":"{{TAVILY_API_KEY}}","query":"ping","max_results":1}',
    },
  },

  // --- Web3 ----------------------------------------------------------------
  {
    id: "birdeye",
    label: "Birdeye",
    category: "web3",
    kind: "api-key",
    obtain: "https://bds.birdeye.so/",
    fields: [
      {
        key: "BIRDEYE_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112",
      headers: { "X-API-KEY": "{{BIRDEYE_API_KEY}}", "x-chain": "solana" },
    },
  },
  {
    id: "hyperliquid",
    label: "Hyperliquid",
    category: "web3",
    kind: "private-key",
    obtain: "Test wallet private key funded on Hyperliquid testnet",
    fields: [
      {
        key: "HYPERLIQUID_PRIVATE_KEY",
        label: "Private key",
        secret: true,
        required: true,
      },
    ],
    // Never transmit private keys anywhere — local shape check only.
    verify: { kind: "format", pattern: "^(0x)?[0-9a-fA-F]{64}$" },
  },
  {
    id: "polymarket",
    label: "Polymarket",
    category: "web3",
    kind: "api-key",
    obtain: "https://docs.polymarket.com/ — API key",
    fields: [
      {
        key: "POLYMARKET_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
    ],
    verify: { kind: "none" },
  },

  // --- Health connectors ---------------------------------------------------
  {
    id: "strava",
    label: "Strava",
    category: "health",
    kind: "token",
    obtain: "https://www.strava.com/settings/api — OAuth access token",
    fields: [
      {
        key: "STRAVA_ACCESS_TOKEN",
        label: "Access token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://www.strava.com/api/v3/athlete",
      headers: { Authorization: "Bearer {{STRAVA_ACCESS_TOKEN}}" },
    },
  },
  {
    id: "oura",
    label: "Oura",
    category: "health",
    kind: "token",
    obtain: "https://cloud.ouraring.com/personal-access-tokens",
    fields: [
      {
        key: "OURA_ACCESS_TOKEN",
        label: "Access token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.ouraring.com/v2/usercollection/personal_info",
      headers: { Authorization: "Bearer {{OURA_ACCESS_TOKEN}}" },
    },
  },
  {
    id: "fitbit",
    label: "Fitbit",
    category: "health",
    kind: "token",
    obtain: "https://dev.fitbit.com/apps — OAuth access token",
    fields: [
      {
        key: "FITBIT_ACCESS_TOKEN",
        label: "Access token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://api.fitbit.com/1/user/-/profile.json",
      headers: { Authorization: "Bearer {{FITBIT_ACCESS_TOKEN}}" },
    },
  },
  {
    id: "withings",
    label: "Withings",
    category: "health",
    kind: "token",
    obtain: "https://developer.withings.com/ — OAuth access token",
    fields: [
      {
        key: "WITHINGS_ACCESS_TOKEN",
        label: "Access token",
        secret: true,
        required: true,
      },
    ],
    verify: {
      kind: "http",
      url: "https://wbsapi.withings.net/v2/user?action=getdevice",
      headers: { Authorization: "Bearer {{WITHINGS_ACCESS_TOKEN}}" },
      okBodyPattern: '"status"\\s*:\\s*0',
    },
  },

  // --- Push delivery -------------------------------------------------------
  {
    id: "apns",
    label: "Apple Push (APNs)",
    category: "push",
    kind: "api-key",
    obtain: "https://developer.apple.com/account/resources/authkeys/list",
    fields: [
      {
        key: "ELIZA_APNS_KEY_ID",
        label: "Key ID",
        secret: false,
        required: true,
      },
      {
        key: "ELIZA_APNS_TEAM_ID",
        label: "Team ID",
        secret: false,
        required: false,
      },
      {
        key: "ELIZA_APNS_PRIVATE_KEY",
        label: "Private key (.p8 contents)",
        secret: true,
        required: false,
      },
    ],
    verify: { kind: "none" },
  },
  {
    id: "fcm",
    label: "Firebase Cloud Messaging",
    category: "push",
    kind: "api-key",
    obtain: "Firebase console — service account JSON",
    fields: [
      {
        key: "ELIZA_FCM_SERVICE_ACCOUNT",
        label: "Service account JSON",
        secret: true,
        required: true,
        multiline: true,
      },
    ],
    verify: { kind: "format", pattern: '"private_key"' },
  },

  // --- Infrastructure ------------------------------------------------------
  {
    id: "postgres",
    label: "PostgreSQL",
    category: "infra",
    kind: "endpoint",
    obtain:
      "Local Postgres, e.g. `docker run -p 5432:5432 -e POSTGRES_PASSWORD=eliza postgres:17`",
    fields: [
      {
        key: "POSTGRES_URL",
        label: "Connection URL",
        secret: true,
        required: true,
        placeholder: "postgres://postgres:eliza@127.0.0.1:5432/postgres",
      },
    ],
    verify: { kind: "tcp", urlVar: "POSTGRES_URL" },
  },
  {
    id: "eliza-cloud",
    label: "Eliza Cloud",
    category: "cloud",
    kind: "cloud-login",
    obtain:
      "Log in with the Connect button (device-code flow) or paste an API key",
    oauth: "eliza-cloud",
    fields: [
      {
        key: "ELIZAOS_CLOUD_API_KEY",
        label: "API key",
        secret: true,
        required: true,
      },
      {
        key: "ELIZA_CLOUD_API_KEY",
        label: "API key (legacy alias; optional, kept in sync)",
        secret: true,
        required: false,
      },
      {
        key: "ELIZAOS_CLOUD_BASE_URL",
        label: "Base URL (optional)",
        secret: false,
        required: false,
        placeholder: "https://elizacloud.ai",
      },
    ],
    verify: { kind: "none" },
  },
];

export function connectionById(id) {
  return CONNECTIONS.find((c) => c.id === id);
}

/** Map every provided env var to the connection(s) that own it. */
export function varOwnership() {
  const owners = new Map();
  for (const connection of CONNECTIONS) {
    for (const field of connection.fields) {
      const list = owners.get(field.key) ?? [];
      list.push(connection.id);
      owners.set(field.key, list);
    }
  }
  return owners;
}

/**
 * A connection is "configured" when all its required fields have non-empty
 * values from saved credentials or the ambient environment (so devs who
 * already export keys in their shell get credit without re-entering them).
 */
export function connectionStatus(connection, savedValues, env = process.env) {
  const values = {};
  const missing = [];
  for (const field of connection.fields) {
    const value = savedValues?.[field.key] ?? env[field.key] ?? "";
    if (typeof value === "string" && value.trim() !== "") {
      values[field.key] = value;
    } else if (field.required) {
      missing.push(field.key);
    }
  }
  return { configured: missing.length === 0, missing, values };
}
