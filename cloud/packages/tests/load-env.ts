/**
 * Preload for bun test: load .env.local and .env.test so DATABASE_URL and other
 * vars are available. Run with: bun test --preload ./tests/load-env.ts ...
 */
import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { applyDatabaseUrlFallback } from "@/db/database-url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const workspaceRoot = resolve(root, "..");

for (const envPath of [
  resolve(workspaceRoot, ".env"),
  resolve(workspaceRoot, ".env.local"),
  resolve(workspaceRoot, ".env.test"),
  resolve(root, ".env"),
  resolve(root, ".env.local"),
  resolve(root, ".env.test"),
]) {
  config({ path: envPath, override: true });
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
