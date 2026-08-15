/**
 * Verifies workspace source aliases target source files without prebuilt dist
 * artifacts, including deterministic package-export fixtures.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildWorkspaceSourceAliases,
  workspaceRepoRoot,
} from "../vitest/source-aliases.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function resolveAlias(
  aliases: ReturnType<typeof buildWorkspaceSourceAliases>,
  specifier: string,
): string {
  const alias = aliases.find(({ find }) => find.test(specifier));
  expect(alias, `${specifier} must have a source alias`).toBeDefined();
  return specifier.replace(alias?.find ?? /$^/, alias?.replacement ?? "");
}

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
      {
        specifier: "@elizaos/plugin-anthropic/endpoint-config",
        target: "plugins/plugin-anthropic/utils/config.ts",
      },
      {
        specifier: "@elizaos/plugin-elizacloud/endpoint-config",
        target: "plugins/plugin-elizacloud/src/utils/config.ts",
      },
      {
        specifier: "@elizaos/plugin-openai/endpoint-config",
        target: "plugins/plugin-openai/utils/config.ts",
      },
    ] as const;

    for (const { specifier, target } of cases) {
      const replacement = resolveAlias(aliases, specifier);
      const resolved = replacement.endsWith(".ts")
        ? replacement
        : target.endsWith("/index.ts")
          ? path.join(replacement, "index.ts")
          : `${replacement}.ts`;
      expect(resolved).toBe(path.join(workspaceRepoRoot, target));
    }
  });

  test("honors exact eliza-source exports before generic package subpaths", () => {
    const repoRoot = mkdtempSync(
      path.join(tmpdir(), "eliza-vitest-source-aliases-"),
    );
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "plugins", "plugin-fixture");
    mkdirSync(path.join(packageDir, "src", "internal"), { recursive: true });
    writeFileSync(path.join(packageDir, "src", "index.ts"), "export {};\n");
    writeFileSync(
      path.join(packageDir, "src", "internal", "endpoint.ts"),
      "export const endpoint = true;\n",
    );
    writeFileSync(
      path.join(packageDir, "src", "internal", "string-endpoint.ts"),
      "export const endpoint = true;\n",
    );
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin.fixture",
        exports: {
          ".": "./dist/index.js",
          "./public+endpoint": {
            "eliza-source": {
              types: "./src/internal/endpoint.ts",
              import: "./src/internal/endpoint.ts",
              default: "./src/internal/endpoint.ts",
            },
            import: "./dist/public-endpoint.js",
          },
          "./string-endpoint": {
            "eliza-source": "./src/internal/string-endpoint.ts",
            import: "./dist/string-endpoint.js",
          },
          "./escape": {
            "eliza-source": "../outside.ts",
            import: "./dist/escape.js",
          },
        },
      }),
    );

    const aliases = buildWorkspaceSourceAliases(repoRoot);
    expect(
      resolveAlias(aliases, "@elizaos/plugin.fixture/public+endpoint"),
    ).toBe(path.join(packageDir, "src", "internal", "endpoint.ts"));
    expect(
      resolveAlias(aliases, "@elizaos/plugin.fixture/string-endpoint"),
    ).toBe(path.join(packageDir, "src", "internal", "string-endpoint.ts"));
    expect(resolveAlias(aliases, "@elizaos/plugin.fixture/escape")).toBe(
      path.join(packageDir, "src", "escape"),
    );
  });
});
