/**
 * Node/Bun build of `./utils`: resolves the PGlite data directory by walking
 * up from cwd to find a `.env` file and to detect whether cwd is inside the
 * elizaOS monorepo (so local dev defaults PGlite data under
 * `<repo-root>/.eliza/.elizadb`), then falls back to `<cwd>/.eliza/.elizadb`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function expandTildePath(filepath: string): string {
  if (filepath.startsWith("~")) {
    return path.join(process.cwd(), filepath.slice(1));
  }
  return filepath;
}

export function resolveEnvFile(startDir: string = process.cwd()): string {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return path.join(startDir, ".env");
}

export function resolvePgliteDir(dir?: string, fallbackDir?: string): string {
  const envPath = resolveEnvFile();
  const dotenvDisabled =
    process.env.ELIZA_BENCH_DISABLE_DOTENV === "1" ||
    process.env.ELIZA_BENCH_SUBSCRIPTION_CHAT_ONLY === "1";
  if (!dotenvDisabled && existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  }

  let monoPath: string | undefined;
  if (existsSync(path.join(process.cwd(), "packages", "core"))) {
    monoPath = process.cwd();
  } else {
    const twoUp = path.resolve(process.cwd(), "../..");
    if (existsSync(path.join(twoUp, "packages", "core"))) {
      monoPath = twoUp;
    }
  }

  const base =
    dir ??
    process.env.PGLITE_DATA_DIR ??
    fallbackDir ??
    (monoPath ? path.join(monoPath, ".eliza", ".elizadb") : undefined) ??
    path.join(process.cwd(), ".eliza", ".elizadb");

  return expandTildePath(base);
}

export {
  MAX_SQL_JSON_SANITIZE_BIGINT_DIGITS,
  MAX_SQL_JSON_SANITIZE_BYTES,
  MAX_SQL_JSON_SANITIZE_DEPTH,
  MAX_SQL_JSON_SANITIZE_KEY_BYTES,
  MAX_SQL_JSON_SANITIZE_NODES,
  MAX_SQL_JSON_SANITIZE_STRING_BYTES,
  SQL_JSON_SANITIZE_UNBOUNDED,
  sanitizeJsonObject,
} from "./sanitize-json.ts";
