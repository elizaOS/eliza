/**
 * Mirror legacy MILADY_* env vars into ELIZA_* so `eliza/packages` only reads ELIZA_*.
 * Call once after loading `.env.worktree` / dotenv and before resolving ports or spawning children.
 */
export function syncElizaEnvAliases() {
  const pairs = [
    ["MILADY_NAMESPACE", "ELIZA_NAMESPACE"],
    ["MILADY_STATE_DIR", "ELIZA_STATE_DIR"],
    ["MILADY_CONFIG_PATH", "ELIZA_CONFIG_PATH"],
    ["MILADY_OAUTH_DIR", "ELIZA_OAUTH_DIR"],
    ["MILADY_AGENT_ORCHESTRATOR", "ELIZA_AGENT_ORCHESTRATOR"],
    ["MILADY_CLOUD_PROVISIONED", "ELIZA_CLOUD_PROVISIONED"],
    ["MILADY_CHAT_GENERATION_TIMEOUT_MS", "ELIZA_CHAT_GENERATION_TIMEOUT_MS"],
    ["MILADY_SKIP_LOCAL_PLUGIN_ROLES", "ELIZA_SKIP_LOCAL_PLUGIN_ROLES"],
    ["MILADY_SETTINGS_DEBUG", "ELIZA_SETTINGS_DEBUG"],
    ["VITE_MILADY_SETTINGS_DEBUG", "VITE_ELIZA_SETTINGS_DEBUG"],
    ["MILADY_GOOGLE_OAUTH_DESKTOP_CLIENT_ID"],
    ["MILADY_API_PORT", "ELIZA_API_PORT"],
    ["MILADY_API_BIND", "ELIZA_API_BIND"],
    ["MILADY_API_TOKEN", "ELIZA_API_TOKEN"],
    ["MILADY_ALLOWED_ORIGINS", "ELIZA_ALLOWED_ORIGINS"],
    ["MILADY_ALLOWED_HOSTS", "ELIZA_ALLOWED_HOSTS"],
    ["MILADY_ALLOW_NULL_ORIGIN", "ELIZA_ALLOW_NULL_ORIGIN"],
    ["MILADY_DISABLE_AUTO_API_TOKEN", "ELIZA_DISABLE_AUTO_API_TOKEN"],
    ["MILADY_TASK_AGENT_AUTH_TRUSTED_HOSTS"],
    ["MILADY_TASK_AGENT_AUTH_API_BASE_URL"],
    ["MILADY_PORT", "ELIZA_UI_PORT"],
  ];
  for (const [from, to] of pairs) {
    if (!to) continue;
    if (!process.env[to] && process.env[from]) {
      process.env[to] = process.env[from];
    }
  }
  if (!process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT) {
    process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT = "eliza";
  }
}
