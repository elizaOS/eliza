/**
 * Verifies workspace and integration source aliases target source files
 * without prebuilt dist artifacts, including deterministic export fixtures.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, normalizePath } from "vite";
import { afterEach, describe, expect, test } from "vitest";
import integrationConfig from "../vitest/integration.config.ts";
import {
  buildWorkspaceSourceAliases,
  workspaceRepoRoot,
} from "../vitest/source-aliases.ts";

const temporaryRoots: string[] = [];

type TestAlias = { find: string | RegExp; replacement: string };

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function findAlias(
  aliases: TestAlias[],
  specifier: string,
): TestAlias | undefined {
  return aliases.find(({ find }) =>
    typeof find === "string"
      ? specifier === find || specifier.startsWith(`${find}/`)
      : find.test(specifier),
  );
}

function resolveAlias(aliases: TestAlias[], specifier: string): string {
  const alias = findAlias(aliases, specifier);
  expect(alias, `${specifier} must have a source alias`).toBeDefined();
  if (!alias) return specifier;
  return specifier.replace(alias.find, alias.replacement);
}

describe("workspace source aliases", () => {
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

  test("honors exact eliza-source exports and null export barriers", () => {
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
          "./private": null,
          "./*": {
            "eliza-source": "./src/*.ts",
            import: "./dist/*.js",
          },
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
          "./retired": null,
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
    for (const suffix of [
      "",
      "?raw",
      "?url",
      "#fragment",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".json",
      ".js?raw",
    ]) {
      expect(
        findAlias(aliases, `@elizaos/plugin.fixture/private${suffix}`),
      ).toBeUndefined();
    }
    for (const subpath of [
      "/private",
      "./private",
      "nested/./private",
      "nested/../private",
      "nested//private",
      "nested\\..\\private",
      "%2e/private",
      "%2E%2e/private",
      "nested%2Fprivate",
      "nested%2fprivate",
      "nested%5Cprivate",
      "nested%5cprivate",
    ]) {
      expect(
        findAlias(aliases, `@elizaos/plugin.fixture/${subpath}`),
      ).toBeUndefined();
    }
    expect(resolveAlias(aliases, "@elizaos/plugin.fixture/private/child")).toBe(
      path.join(packageDir, "src", "private", "child"),
    );
    expect(resolveAlias(aliases, "@elizaos/plugin.fixture/escape")).toBe(
      path.join(packageDir, "src", "escape"),
    );
  });

  test("keeps null-export spellings under package-exports authority in Vite", async () => {
    const aliases = buildWorkspaceSourceAliases(workspaceRepoRoot);
    const server = await createServer({
      configFile: false,
      root: workspaceRepoRoot,
      logLevel: "silent",
      server: { middlewareMode: true },
      resolve: { alias: aliases },
    });
    const importer = path.join(
      workspaceRepoRoot,
      "packages/scripts/__tests__/vite-null-export-probe.ts",
    );
    const blockedSpecifier = "@elizaos/agent/runtime/runtime-installation-id";
    const agentSourcePrefix = `${normalizePath(
      path.join(workspaceRepoRoot, "packages", "agent", "src"),
    )}/`;
    const specifiers = [
      ...[
        "",
        "?raw",
        "?url",
        "#fragment",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".json",
        ".js?raw",
      ].map((suffix) => `${blockedSpecifier}${suffix}`),
      "@elizaos/agent/./runtime/runtime-installation-id",
      "@elizaos/agent/runtime/./runtime-installation-id",
      "@elizaos/agent/runtime//runtime-installation-id",
      "@elizaos/agent/runtime/../runtime/runtime-installation-id",
      "@elizaos/agent/runtime/.//runtime-installation-id",
      "@elizaos/agent/runtime\\..\\runtime\\runtime-installation-id",
      "@elizaos/agent/runtime/%2e/runtime-installation-id",
      "@elizaos/agent/runtime/%2E%2e/runtime/runtime-installation-id",
      "@elizaos/agent/runtime%2Fruntime-installation-id",
      "@elizaos/agent/runtime%2fruntime-installation-id",
      "@elizaos/agent/runtime%5Cruntime-installation-id",
      "@elizaos/agent/runtime%5cruntime-installation-id",
    ];

    try {
      for (const specifier of specifiers) {
        const resolution = await server.pluginContainer
          .resolveId(specifier, importer)
          .then(
            (resolved) => ({ resolved }),
            (error: unknown) => ({ error }),
          );
        if ("error" in resolution) {
          expect(String(resolution.error)).toMatch(
            /is not exported|Invalid "exports" target/,
          );
        } else if (resolution.resolved) {
          expect(
            normalizePath(resolution.resolved.id).startsWith(agentSourcePrefix),
            `${specifier} must stay under package-exports authority`,
          ).toBe(false);
        }
      }
    } finally {
      await server.close();
    }
  });
});
