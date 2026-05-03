/**
 * Mirror branded ELIZA_* env vars into ELIZA_* so `eliza/packages` only reads ELIZA_*.
 * Call once after loading `.env.worktree` / dotenv and before resolving ports or spawning children.
 */
export function syncElizaEnvAliases() {
  const pairs = [
    ["ELIZA_NAMESPACE", "ELIZA_NAMESPACE"],
    ["ELIZA_STATE_DIR", "ELIZA_STATE_DIR"],
    ["ELIZA_CONFIG_PATH", "ELIZA_CONFIG_PATH"],
    ["ELIZA_OAUTH_DIR", "ELIZA_OAUTH_DIR"],
    ["ELIZA_AGENT_ORCHESTRATOR", "ELIZA_AGENT_ORCHESTRATOR"],
    ["ELIZA_CLOUD_PROVISIONED", "ELIZA_CLOUD_PROVISIONED"],
    ["ELIZA_CHAT_GENERATION_TIMEOUT_MS", "ELIZA_CHAT_GENERATION_TIMEOUT_MS"],
    ["ELIZA_SKIP_LOCAL_PLUGIN_ROLES", "ELIZA_SKIP_LOCAL_PLUGIN_ROLES"],
    ["ELIZA_SETTINGS_DEBUG", "ELIZA_SETTINGS_DEBUG"],
    ["VITE_ELIZA_SETTINGS_DEBUG", "VITE_ELIZA_SETTINGS_DEBUG"],
    ["ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID"],
    ["ELIZA_API_PORT", "ELIZA_API_PORT"],
    ["ELIZA_API_BIND", "ELIZA_API_BIND"],
    ["ELIZA_API_TOKEN", "ELIZA_API_TOKEN"],
    ["ELIZA_ALLOWED_ORIGINS", "ELIZA_ALLOWED_ORIGINS"],
    ["ELIZA_ALLOWED_HOSTS", "ELIZA_ALLOWED_HOSTS"],
    ["ELIZA_ALLOW_NULL_ORIGIN", "ELIZA_ALLOW_NULL_ORIGIN"],
    ["ELIZA_DISABLE_AUTO_API_TOKEN", "ELIZA_DISABLE_AUTO_API_TOKEN"],
    ["ELIZA_TASK_AGENT_AUTH_TRUSTED_HOSTS"],
    ["ELIZA_TASK_AGENT_AUTH_API_BASE_URL"],
    ["ELIZA_PORT", "ELIZA_UI_PORT"],
  ];
  for (const [from, to] of pairs) {
    if (!process.env[to] && process.env[from]) {
      process.env[to] = process.env[from];
    }
  }
  if (!process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT) {
    process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT = "eliza";
  }
}
