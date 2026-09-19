/**
 * Guards standalone source-checkout startup against stale generated workspace
 * artifacts. Real children import storage from isolated source-only packages using
 * the same Bun condition as `bun run start`, so existing dist cannot hide a
 * missing source export.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("standalone source-checkout start contract", () => {
  it.each([
    ["plugin-sql", "@elizaos/plugin-sql"],
    ["plugin-inmemorydb", "@elizaos/plugin-inmemorydb"],
    ["plugin-inmemorydb", "@elizaos/plugin-inmemorydb/runtime"],
  ])("imports %s through %s without generated output", (name, specifier) => {
    const fixture = mkdtempSync(path.join(tmpdir(), "eliza-source-start-"));
    const packageRoot = path.resolve(AGENT_ROOT, "../../plugins", name);
    const isolatedPackage = path.join(fixture, "node_modules/@elizaos", name);
    try {
      mkdirSync(isolatedPackage, { recursive: true });
      cpSync(
        path.join(packageRoot, "package.json"),
        path.join(isolatedPackage, "package.json"),
      );
      symlinkSync(
        path.resolve(AGENT_ROOT, "../../node_modules"),
        path.join(isolatedPackage, "node_modules"),
        "junction",
      );
      for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
        const source = path.join(packageRoot, entry.name);
        const target = path.join(isolatedPackage, entry.name);
        if (entry.isDirectory() && entry.name === "src")
          symlinkSync(source, target, "junction");
        else if (entry.isFile() && entry.name.endsWith(".ts"))
          cpSync(source, target);
      }
      const imported = spawnSync(
        "bun",
        [
          "--no-install",
          "--conditions=eliza-source",
          "-e",
          `await import(${JSON.stringify(specifier)}); console.log("source-import-ok")`,
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 30_000,
        },
      );

      expect(imported.error).toBeUndefined();
      expect(imported.status, imported.stderr).toBe(0);
      expect(imported.stdout).toContain("source-import-ok");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
