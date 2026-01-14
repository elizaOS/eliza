import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Load environment variables from:
 * - `process.cwd()/.env` (default dotenv behavior)
 * - repo root `.env` (useful when running from `examples/code`)
 */
export function loadEnv(): void {
  // Load .env from current working directory if present.
  config();

  // Also try to load from the monorepo root.
  // This file lives at: examples/code/src/lib/load-env.ts
  // Repo root is: ../../../../.env
  const rootEnvPath = fileURLToPath(
    new URL("../../../../.env", import.meta.url),
  );
  if (existsSync(rootEnvPath)) {
    config({ path: rootEnvPath, override: false });
  }
}
