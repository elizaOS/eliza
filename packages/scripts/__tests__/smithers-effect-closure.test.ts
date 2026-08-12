/**
 * Locks the Smithers Effect 4 closure to one peer-compatible prerelease across manifests and Bun's resolved graph.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const EFFECT_VERSION = "4.0.0-beta.102";
const SMITHERS_VERSION = "0.32.0";
const PLUGIN_WORKSPACES = [
  "plugins/plugin-agent-orchestrator",
  "plugins/plugin-workflow",
];

type JsonObject = Record<string, unknown>;
type LockPackage = readonly [string, string, JsonObject?];

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return value;
}

function manifest(relativePath: string): JsonObject {
  return objectValue(
    JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8")),
    relativePath,
  );
}

function packageEntry(packages: JsonObject, name: string): LockPackage {
  const value = packages[name];
  if (
    !Array.isArray(value) ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string"
  ) {
    throw new TypeError(`bun.lock packages.${name} must be a package tuple`);
  }
  const metadata = value[2];
  return metadata === undefined
    ? [value[0], value[1]]
    : [
        value[0],
        value[1],
        objectValue(metadata, `bun.lock packages.${name} metadata`),
      ];
}

function resolvedVersion(packages: JsonObject, name: string): string {
  const resolution = packageEntry(packages, name)[0];
  const prefix = `${name}@`;
  if (!resolution.startsWith(prefix)) {
    throw new TypeError(
      `bun.lock packages.${name} has invalid resolution ${resolution}`,
    );
  }
  return resolution.slice(prefix.length);
}

test("Smithers resolves one peer-compatible Effect prerelease", () => {
  for (const workspacePath of PLUGIN_WORKSPACES) {
    const relativePath = `${workspacePath}/package.json`;
    const dependencies = objectValue(
      manifest(relativePath).dependencies,
      `${relativePath}.dependencies`,
    );
    expect(stringField(dependencies, "effect", relativePath)).toBe(
      EFFECT_VERSION,
    );
    expect(
      stringField(dependencies, "@smithers-orchestrator/engine", relativePath),
    ).toBe(SMITHERS_VERSION);
  }

  const rootManifest = manifest("package.json");
  const manifestOverrides = objectValue(
    rootManifest.overrides,
    "package.json.overrides",
  );
  expect(
    stringField(
      manifestOverrides,
      "@effect/platform-node-shared",
      "package.json.overrides",
    ),
  ).toBe(EFFECT_VERSION);

  const lock = objectValue(
    Bun.JSONC.parse(readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8")),
    "bun.lock",
  );
  const workspaces = objectValue(lock.workspaces, "bun.lock.workspaces");
  const packages = objectValue(lock.packages, "bun.lock.packages");
  const lockOverrides = objectValue(lock.overrides, "bun.lock.overrides");
  expect(
    stringField(
      lockOverrides,
      "@effect/platform-node-shared",
      "bun.lock.overrides",
    ),
  ).toBe(EFFECT_VERSION);

  for (const workspacePath of PLUGIN_WORKSPACES) {
    const workspace = objectValue(
      workspaces[workspacePath],
      `bun.lock.workspaces.${workspacePath}`,
    );
    const dependencies = objectValue(
      workspace.dependencies,
      `bun.lock.workspaces.${workspacePath}.dependencies`,
    );
    expect(stringField(dependencies, "effect", workspacePath)).toBe(
      EFFECT_VERSION,
    );
    expect(
      stringField(dependencies, "@smithers-orchestrator/engine", workspacePath),
    ).toBe(SMITHERS_VERSION);
  }

  const coreVersion = resolvedVersion(packages, "effect");
  expect(resolvedVersion(packages, "@smithers-orchestrator/engine")).toBe(
    SMITHERS_VERSION,
  );
  const platformBunVersion = resolvedVersion(packages, "@effect/platform-bun");
  const platformNodeVersion = resolvedVersion(
    packages,
    "@effect/platform-node-shared",
  );
  expect(coreVersion).toBe(EFFECT_VERSION);
  expect(platformBunVersion).toBe(coreVersion);
  expect(platformNodeVersion).toBe(platformBunVersion);

  const platformBunMetadata = objectValue(
    packageEntry(packages, "@effect/platform-bun")[2],
    "bun.lock packages.@effect/platform-bun metadata",
  );
  const platformBunDependencies = objectValue(
    platformBunMetadata.dependencies,
    "bun.lock packages.@effect/platform-bun.dependencies",
  );
  const platformNodeRange = stringField(
    platformBunDependencies,
    "@effect/platform-node-shared",
    "bun.lock packages.@effect/platform-bun.dependencies",
  );
  expect(Bun.semver.satisfies(platformNodeVersion, platformNodeRange)).toBe(
    true,
  );

  const effectPeerPackages = Object.keys(packages)
    .filter((name) => name.startsWith("@effect/"))
    .map((name) => {
      const metadata = packageEntry(packages, name)[2];
      if (!metadata) return undefined;
      const peerDependencies = metadata.peerDependencies;
      if (
        typeof peerDependencies !== "object" ||
        peerDependencies === null ||
        Array.isArray(peerDependencies)
      ) {
        return undefined;
      }
      const effectRange = peerDependencies.effect;
      return typeof effectRange === "string"
        ? { effectRange, name }
        : undefined;
    })
    .filter((entry) => entry !== undefined);

  expect(effectPeerPackages.length).toBeGreaterThan(0);
  for (const { effectRange, name } of effectPeerPackages) {
    expect(
      Bun.semver.satisfies(coreVersion, effectRange),
      `${name} requires effect ${effectRange}, resolved ${coreVersion}`,
    ).toBe(true);
  }
});
