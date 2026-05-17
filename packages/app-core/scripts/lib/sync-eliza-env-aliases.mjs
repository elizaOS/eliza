/**
 * Normalize local app env aliases before resolving ports or spawning children.
 * Call once after loading `.env.worktree` / dotenv.
 */
export function syncElizaEnvAliases() {
  const pairs = [["ELIZA_PORT", "ELIZA_UI_PORT"]];
  for (const [from, to] of pairs) {
    if (!process.env[to] && process.env[from]) {
      process.env[to] = process.env[from];
    }
  }
  if (!process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT) {
    process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT = "eliza";
  }
}
