/**
 * Verifies workspace source aliases target both file and directory package
 * subpaths without relying on prebuilt dist artifacts.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildWorkspaceSourceAliases,
  workspaceRepoRoot,
} from "../vitest/source-aliases.ts";

describe("workspace source aliases", () => {
  test("resolve file and directory subpaths to source targets", () => {
    const aliases = buildWorkspaceSourceAliases(workspaceRepoRoot);
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
      const alias = aliases.find(({ find }) => find.test(specifier));
      expect(alias, `${specifier} must have a source alias`).toBeDefined();
      const replacement = specifier.replace(
        alias?.find ?? /$^/,
        alias?.replacement ?? "",
      );
      const resolved = target.endsWith("/index.ts")
        ? path.join(replacement, "index.ts")
        : `${replacement}.ts`;
      expect(resolved).toBe(path.join(workspaceRepoRoot, target));
    }
  });
});
