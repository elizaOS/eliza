// Provides shared support logic for the Code example.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

interface LoadEnvDependencies {
  existsSync(path: string): boolean;
  config(options: { path?: string; override?: boolean; quiet: boolean }): void;
}

const defaultDependencies: LoadEnvDependencies = { existsSync, config };

/**
 * Load environment variables from:
 * - `process.cwd()/.env` (default dotenv behavior)
 * - repo root `.env` (useful when running from `examples/code`)
 */
export function loadEnv(
  dependencies: LoadEnvDependencies = defaultDependencies,
): void {
  // Load .env from current working directory if present.
  dependencies.config({ quiet: true });

  // Also try to load from the monorepo root.
  // This file lives at: examples/code/src/lib/load-env.ts
  // Repo root is: ../../../../.env
  const rootEnvPath = fileURLToPath(
    new URL("../../../../.env", import.meta.url),
  );
  if (dependencies.existsSync(rootEnvPath)) {
    dependencies.config({ path: rootEnvPath, override: false, quiet: true });
  }
}
