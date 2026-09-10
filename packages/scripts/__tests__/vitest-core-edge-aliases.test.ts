/**
 * Verifies package test configs resolve the scheduling runtime's core edge
 * import to a real source entry before their broad bare-core aliases.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import codingToolsConfig from "../../../plugins/plugin-coding-tools/vitest.config";
import defaultConfig from "../vitest/default.config";
import { repoRoot } from "../vitest/repo-root";

type Alias = { find: string | RegExp; replacement: string };

function resolveAlias(config: unknown, specifier: string): string {
  const aliases = (config as { resolve?: { alias?: Alias[] } }).resolve?.alias;
  if (!Array.isArray(aliases)) {
    throw new TypeError("Vitest aliases must be an ordered array");
  }
  const alias = aliases.find(({ find }) =>
    typeof find === "string"
      ? specifier === find || specifier.startsWith(`${find}/`)
      : find.test(specifier),
  );
  if (!alias) throw new TypeError(`No alias found for ${specifier}`);
  return specifier.replace(alias.find, alias.replacement);
}

describe("@elizaos/core/edge package-test aliases", () => {
  test.each([
    ["shared package config", defaultConfig],
    ["coding-tools config", codingToolsConfig],
  ])("%s targets the edge source entry", (_label, config) => {
    expect(resolveAlias(config, "@elizaos/core/edge")).toBe(
      path.join(repoRoot, "packages/core/src/index.edge.ts"),
    );
  });

  test("coding-tools keeps core's cloud-routing re-export on source", () => {
    expect(resolveAlias(codingToolsConfig, "@elizaos/cloud-routing")).toBe(
      path.join(repoRoot, "packages/cloud/routing/src/index.ts"),
    );
  });

  test("shared package config keeps the agent vault dependency on source", () => {
    expect(resolveAlias(defaultConfig, "@elizaos/vault")).toBe(
      path.join(repoRoot, "packages/vault/src/index.ts"),
    );
  });

  test("shared package config resolves the agent's app-manager plugin", () => {
    expect(resolveAlias(defaultConfig, "@elizaos/plugin-app-manager")).toBe(
      path.join(repoRoot, "plugins/plugin-app-manager/src/index.ts"),
    );
  });

  test.each([
    [
      "@elizaos/core/contracts/first-run-options",
      "packages/core/src/contracts/first-run-options.ts",
    ],
    ["@elizaos/core/runtime-env", "packages/core/src/runtime-env.ts"],
  ])(
    "shared package config resolves %s to its source leaf",
    (specifier, file) => {
      expect(resolveAlias(defaultConfig, specifier)).toBe(
        path.join(repoRoot, file),
      );
    },
  );
});
