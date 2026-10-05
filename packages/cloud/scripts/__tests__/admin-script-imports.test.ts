/**
 * Pins that the Cloud operator scripts load their Cloud modules through the
 * `@elizaos/cloud-shared` package exports rather than the `@/` path alias,
 * which only `packages/cloud/shared/tsconfig.json` defines and which no
 * runtime resolves from `packages/cloud/scripts`. The static scan covers every
 * non-test module in the package; the runtime checks start the two scripts whose first
 * action after argument parsing is that import, in a clean working directory
 * with no `.env` files, and stop them before they reach a database.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../../../scripts/lib/spawn-sync-captured.ts";

const scriptsRoot = new URL("../", import.meta.url).pathname;
const adminDirectory = join(scriptsRoot, "admin");

function typescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules") continue;
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...typescriptFiles(fullPath));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const aliasImportPattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["']@\/[^"']*["']/g;

function aliasImports(source: string): string[] {
  return [...source.matchAll(aliasImportPattern)].map((match) => match[0]);
}

function runScript(scriptName: string, args: string[]) {
  const cleanDirectory = mkdtempSync(join(tmpdir(), "cloud-admin-script-"));
  try {
    return spawnSync(
      process.execPath,
      ["--conditions=eliza-source", join(adminDirectory, scriptName), ...args],
      {
        cwd: cleanDirectory,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "pglite://memory" },
        timeout: 60_000,
      },
    );
  } finally {
    rmSync(cleanDirectory, { recursive: true, force: true });
  }
}

describe("cloud operator script imports", () => {
  test("the alias scanner recognises static and dynamic forms", () => {
    expect(
      aliasImports(
        'import { a } from "@/lib/a";\nconst b = await import(\n  "@/db/b"\n);\nimport("@elizaos/cloud-shared/lib/c");',
      ),
    ).toEqual(['from "@/lib/a"', 'import(\n  "@/db/b"']);
  });

  test("no script under packages/cloud/scripts imports through the @/ alias", () => {
    const files = typescriptFiles(scriptsRoot);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .map((file) => ({
        file: file.slice(scriptsRoot.length),
        imports: aliasImports(readFileSync(file, "utf8")),
      }))
      .filter((entry) => entry.imports.length > 0);
    expect(offenders).toEqual([]);
  });

  test("refund-crypto-payment loads the refund service before validating input", () => {
    // A zero amount is refused by the service's own input validation, which
    // runs before any database access.
    const result = runScript("refund-crypto-payment.ts", [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "0",
      "support-ticket-0001",
      "00000000-0000-4000-8000-000000000003",
      "operator",
      "probe",
    ]);
    expect(result.stderr).not.toContain("Cannot find module");
    expect(result.stderr).toContain("CRYPTO_REFUND_INVALID_AMOUNT");
    expect(result.status).toBe(1);
  });

  test("promote-admin loads the admin service before handling --revoke", () => {
    const result = runScript("promote-admin.ts", ["--revoke"]);
    expect(result.stderr).not.toContain("Cannot find module");
    expect(result.stderr).toContain("Wallet address required for --revoke");
    expect(result.status).toBe(1);
  });
});
