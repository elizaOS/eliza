/**
 * Seed the local dev env defaults before resolving ports or spawning children.
 * Call once after loading `.env.worktree` / dotenv.
 */
export function seedDevEnvDefaults() {
  if (!process.env.ELIZA_UI_PORT && process.env.ELIZA_PORT) {
    process.env.ELIZA_UI_PORT = process.env.ELIZA_PORT;
  }
  if (!process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT) {
    process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT = "eliza";
  }
}
