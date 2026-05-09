/**
 * Preload for bun test: load .env.local and .env.test so DATABASE_URL and other
 * vars are available. Run with: bun test --preload ./tests/load-env.ts ...
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDatabaseUrlFallback } from "@/db/database-url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const workspaceRoot = resolve(root, "..");

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const unquoted = value.slice(1, -1);
    return value.startsWith('"') ? unquoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : unquoted;
  }
  return value;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    process.env[key] = parseEnvValue(assignment.slice(separator + 1));
  }
}

for (const envPath of [
  resolve(workspaceRoot, ".env"),
  resolve(workspaceRoot, ".env.local"),
  resolve(workspaceRoot, ".env.test"),
  resolve(root, ".env"),
  resolve(root, ".env.local"),
  resolve(root, ".env.test"),
]) {
  loadEnvFile(envPath);
}

// Keep all test execution pinned to the local app surface.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
const localAppUrl =
  process.env.TEST_BASE_URL ||
  process.env.TEST_SERVER_URL ||
  `http://localhost:${process.env.TEST_SERVER_PORT || "3000"}`;
process.env.NEXT_PUBLIC_APP_URL = localAppUrl;
process.env.ELIZAOS_CLOUD_BASE_URL = `${localAppUrl}/api/v1`;
process.env.TEST_BLOCK_ANONYMOUS = "true";

if (process.env.SKIP_DB_DEPENDENT === "1") {
  delete process.env.DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
} else if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
} else {
  applyDatabaseUrlFallback(process.env);
}
