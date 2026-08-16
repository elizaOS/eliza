/**
 * Verifies workspace and integration source aliases target source files
 * without prebuilt dist artifacts, including deterministic export fixtures.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import defaultConfig from "../vitest/default.config.ts";
import integrationConfig from "../vitest/integration.config.ts";
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
  aliases: Array<{ find: string | RegExp; replacement: string }>,
  specifier: string,
): string {
  const alias = aliases.find(({ find }) =>
    typeof find === "string"
      ? specifier === find || specifier.startsWith(`${find}/`)
      : find.test(specifier),
  );
  expect(alias, `${specifier} must have a source alias`).toBeDefined();
  if (!alias) return specifier;
  return specifier.replace(alias.find, alias.replacement);
}

describe("workspace source aliases", () => {
  test("keeps the core edge entry ahead of the default bare-package alias", () => {
    const aliases = defaultConfig.resolve?.alias;
    if (!Array.isArray(aliases)) {
      throw new Error("Default aliases must be an ordered array");
    }

    expect(resolveAlias(aliases, "@elizaos/core/edge")).toBe(
      path.join(workspaceRepoRoot, "packages/core/src/index.edge.ts"),
    );
  });

  test("keeps package-aware aliases effective in the integration lane", () => {
    const aliases = integrationConfig.resolve?.alias;
    if (!Array.isArray(aliases)) {
      throw new Error("Integration aliases must be an ordered array");
    }

    const replacement = resolveAlias(
      aliases as Array<{ find: string | RegExp; replacement: string }>,
      "@elizaos/plugin-elizacloud/endpoint-config",
    );

    expect(replacement).toBe(
      path.join(
        workspaceRepoRoot,
        "plugins/plugin-elizacloud/src/utils/config.ts",
      ),
    );
  });

  test("resolve file and directory subpaths to source targets", () => {
    const aliases = buildWorkspaceSourceAliases(workspaceRepoRoot);
    const cases = [
      {
        specifier: "@elizaos/core/edge",
        target: "packages/core/src/index.edge.ts",
      },
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
