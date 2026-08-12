/**
 * Proves the Biome consistency guard accepts the repository and rejects drift in every governed layer.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectBiomeVersionProblems } from "../check-biome-version-consistency.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const temporaryRoots: string[] = [];
const PLATFORMS = [
  "@biomejs/cli-darwin-arm64",
  "@biomejs/cli-darwin-x64",
  "@biomejs/cli-linux-arm64",
  "@biomejs/cli-linux-arm64-musl",
  "@biomejs/cli-linux-x64",
  "@biomejs/cli-linux-x64-musl",
  "@biomejs/cli-win32-arm64",
  "@biomejs/cli-win32-x64",
];

function makeLock(version: string): string {
  const optionalDependencies = PLATFORMS.map(
    (name) => `"${name}": "${version}"`,
  ).join(", ");
  const platformResolutions = PLATFORMS.map(
    (name) => `"${name}": ["${name}@${version}"]`,
  ).join(",\n");
  return `{
  "workspaces": { "": { "devDependencies": { "@biomejs/biome": "${version}" } } },
  "overrides": { "@biomejs/biome": "${version}" },
  "packages": {
    "@biomejs/biome": ["@biomejs/biome@${version}", "", { "optionalDependencies": { ${optionalDependencies} } }],
    ${platformResolutions}
  }
}`;
}

function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "eliza-biome-version-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, "nested"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      devDependencies: { "@biomejs/biome": "2.5.4" },
      overrides: { "@biomejs/biome": "2.5.4" },
    }),
  );
  writeFileSync(
    path.join(root, "nested/package.json"),
    JSON.stringify({ devDependencies: { "@biomejs/biome": "2.5.4" } }),
  );
  writeFileSync(
    path.join(root, "biome.json"),
    JSON.stringify({
      $schema: "https://biomejs.dev/schemas/2.5.4/schema.json",
    }),
  );
  writeFileSync(path.join(root, "bun.lock"), makeLock("2.5.4"));
  writeFileSync(path.join(root, "nested/bun.lock"), makeLock("2.5.4"));
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Biome version consistency", () => {
  it("accepts the tracked repository state", () => {
    expect(collectBiomeVersionProblems(REPO_ROOT)).toEqual([]);
  });

  it(
    "accepts an aligned synthetic repository",
    () => {
      const root = makeFixture();
      expect(
        collectBiomeVersionProblems(root, {
          packageFiles: ["package.json", "nested/package.json"],
          configFiles: ["biome.json"],
          lockFiles: ["bun.lock", "nested/bun.lock"],
        }),
      ).toEqual([]);
    },
    // Fixture writes hit real disk; a loaded CI host has pushed this past the
    // 5s default (11.7s observed on the scenario-runner lane).
    60_000,
  );

  it("accepts a CRLF lockfile from a Windows checkout", () => {
    const root = makeFixture();
    writeFileSync(
      path.join(root, "bun.lock"),
      makeLock("2.5.4").replaceAll("\n", "\r\n"),
    );
    expect(
      collectBiomeVersionProblems(root, {
        packageFiles: ["package.json", "nested/package.json"],
        configFiles: ["biome.json"],
        lockFiles: ["bun.lock", "nested/bun.lock"],
      }),
    ).toEqual([]);
  });

  it("reports manifest, schema, and lockfile drift together", () => {
    const root = makeFixture();
    writeFileSync(
      path.join(root, "nested/package.json"),
      JSON.stringify({ devDependencies: { "@biomejs/biome": "2.5.1" } }),
    );
    writeFileSync(
      path.join(root, "biome.json"),
      JSON.stringify({
        $schema: "https://biomejs.dev/schemas/2.5.1/schema.json",
      }),
    );
    writeFileSync(path.join(root, "bun.lock"), makeLock("2.5.1"));

    const problems = collectBiomeVersionProblems(root, {
      packageFiles: ["package.json", "nested/package.json"],
      configFiles: ["biome.json"],
      lockFiles: ["bun.lock", "nested/bun.lock"],
    }).join("\n");
    expect(problems).toContain("nested/package.json devDependencies: 2.5.1");
    expect(problems).toContain("biome.json schema:");
    expect(problems).toContain("bun.lock: resolved Biome version 2.5.1");
  });

  it("reports a stale standalone lockfile", () => {
    const root = makeFixture();
    writeFileSync(path.join(root, "nested/bun.lock"), makeLock("2.4.4"));

    const problems = collectBiomeVersionProblems(root, {
      packageFiles: ["package.json", "nested/package.json"],
      configFiles: ["biome.json"],
      lockFiles: ["bun.lock", "nested/bun.lock"],
    }).join("\n");
    expect(problems).toContain("nested/bun.lock: resolved Biome version 2.4.4");
  });
});
