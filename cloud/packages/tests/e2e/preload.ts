import "../load-env";
import { ensureLocalTestAuth } from "../infrastructure/local-test-auth";

const DEFAULT_TEST_SECRETS_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const OPTIONAL_OAUTH_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
] as const;

// Keep DB-backed integration/e2e suites deterministic on developer machines even
// when local .env files contain optional OAuth provider credentials.
if (!process.env.SECRETS_MASTER_KEY) {
  process.env.SECRETS_MASTER_KEY = DEFAULT_TEST_SECRETS_MASTER_KEY;
}

process.env.CRON_SECRET ??= "test-cron-secret";
process.env.INTERNAL_SECRET ??= "test-internal-secret";
process.env.AGENT_TEST_BOOTSTRAP_ADMIN ??= "true";
process.env.PLAYWRIGHT_TEST_AUTH ??= "true";
process.env.PLAYWRIGHT_TEST_AUTH_SECRET ??= "playwright-local-auth-secret";
process.env.PAYOUT_STATUS_SKIP_LIVE_BALANCE ??= "1";

// `/api/v1/models` and `/api/v1/messages` short-circuit to 503 when no AI
// provider is configured. The e2e test fixtures don't actually call the
// upstream provider — `model-catalog` reads from a static fallback and the
// chat endpoints are mocked at the SDK layer — but the gate runs first.
// Inject deterministic fake keys so the gate passes without leaking real
// secrets. These must not look like sample placeholders because provider-env
// intentionally filters those out.
process.env.OPENROUTER_API_KEY ??= "sk-or-e2e-test-token";
process.env.OPENAI_API_KEY ??= "sk-e2e-test-token";
process.env.ANTHROPIC_API_KEY ??= "sk-ant-e2e-test-token";

if (process.env.PRESERVE_LOCAL_OAUTH_PROVIDER_ENV !== "1") {
  for (const envVar of OPTIONAL_OAUTH_ENV_VARS) {
    process.env[envVar] = "";
  }
}

if (process.env.SKIP_DB_DEPENDENT === "1") {
  throw new Error("E2E suites require a bootstrapped test database; unset SKIP_DB_DEPENDENT.");
}

await ensureLocalTestAuth();
await import("./setup-server");
