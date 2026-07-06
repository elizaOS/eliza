/**
 * Verifies the duplicated Docker package lists stay aligned without importing
 * the linker, whose module body mutates node_modules as a build side effect.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..", "..", "..");

function readStringArray(filePath, variableName) {
  const source = readFileSync(filePath, "utf8");
  const match = source.match(
    new RegExp(`const ${variableName} = \\[([\\s\\S]*?)\\];`),
  );
  if (!match) {
    throw new Error(`Could not find ${variableName} in ${filePath}`);
  }
  return [...match[1].matchAll(/^\s*"([^"]+)",?$/gm)].map((entry) => entry[1]);
}

const collectListPath = path.join(
  scriptsDir,
  "collect-docker-runtime-deps.mjs",
);
const linkListPath = path.join(
  scriptsDir,
  "link-docker-local-app-packages.mjs",
);

function normalizedLinkedPackages() {
  return readStringArray(linkListPath, "localPackages").map((entry) =>
    entry.replace(/^eliza\//, ""),
  );
}

describe("Docker local package lists", () => {
  it("keeps collected runtime dependencies aligned with linked workspace packages", () => {
    const collected = new Set(
      readStringArray(collectListPath, "LINKED_WORKSPACE_PACKAGES"),
    );
    const linked = new Set(normalizedLinkedPackages());

    expect([...collected].filter((entry) => !linked.has(entry)).sort()).toEqual(
      ["packages/agent"],
    );
    expect([...linked].filter((entry) => !collected.has(entry)).sort()).toEqual(
      ["packages/ui"],
    );
  });

  it("only links scoped elizaOS packages into the local Docker image", () => {
    for (const packagePath of normalizedLinkedPackages()) {
      const packageJsonPath = path.join(repoRoot, packagePath, "package.json");
      expect(
        existsSync(packageJsonPath),
        `${packagePath} must have a package.json`,
      ).toBe(true);

      const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      expect(manifest.name, `${packagePath} must be @elizaos-scoped`).toMatch(
        /^@elizaos\//,
      );
    }
  });
});
