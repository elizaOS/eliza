/**
 * Verifies workspace source aliases resolve both file and directory package
 * subpaths through Vite without relying on prebuilt dist artifacts.
 */

import path from "node:path";
import { createServer } from "vite";
import { describe, expect, test } from "vitest";
import { buildHarnessSourceAliases, harnessRepoRoot } from "./source-aliases";

describe("workspace source aliases", () => {
  test("resolve file and directory subpaths through Vite", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: harnessRepoRoot,
      server: { middlewareMode: true },
      resolve: { alias: buildHarnessSourceAliases(harnessRepoRoot) },
    });

    try {
      const importer = path.join(
        harnessRepoRoot,
        "packages/agent/src/services/agent-backup.ts",
      );
      const cases = [
        {
          specifier: "@elizaos/security/mcp-server-config",
          target: "packages/security/src/mcp-server-config.ts",
        },
        {
          specifier: "@elizaos/security/kms",
          target: "packages/security/src/kms/index.ts",
        },
      ] as const;

      for (const { specifier, target } of cases) {
        const resolved = await server.pluginContainer.resolveId(
          specifier,
          importer,
        );
        expect(resolved?.id).toBe(path.join(harnessRepoRoot, target));
      }
    } finally {
      await server.close();
    }
  });
});
