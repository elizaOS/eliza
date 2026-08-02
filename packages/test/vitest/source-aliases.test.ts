/**
 * Verifies workspace source aliases resolve both file and directory package
 * subpaths through Vite without relying on prebuilt dist artifacts.
 */

import path from "node:path";
import { createServer } from "vite";
import { describe, expect, test } from "vitest";
import {
  buildWorkspaceSourceAliases,
  workspaceRepoRoot,
} from "./source-aliases";

describe("workspace source aliases", () => {
  test("resolve file and directory subpaths through Vite", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: workspaceRepoRoot,
      server: { middlewareMode: true },
      resolve: { alias: buildWorkspaceSourceAliases(workspaceRepoRoot) },
    });

    try {
      const importer = path.join(
        workspaceRepoRoot,
        "packages/agent/src/services/agent-backup.ts",
      );
      const cases = [
        {
          specifier: "@elizaos/core/security/mcp-server-config",
          target: "packages/core/src/security/mcp-server-config.ts",
        },
        {
          specifier: "@elizaos/core/security/kms",
          target: "packages/core/src/security/kms/index.ts",
        },
      ] as const;

      for (const { specifier, target } of cases) {
        const resolved = await server.pluginContainer.resolveId(
          specifier,
          importer,
        );
        expect(resolved?.id).toBe(path.join(workspaceRepoRoot, target));
      }
    } finally {
      await server.close();
    }
  });
});
