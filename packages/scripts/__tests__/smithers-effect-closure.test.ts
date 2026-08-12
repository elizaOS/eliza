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
const EFFECT_RANGE_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type JsonObject = Record<string, unknown>;
type LockPackage = {
  metadata?: JsonObject;
  resolution: string;
};

const EFFECT_CLOSURE_FIXTURE: JsonObject = {
  effect: [`effect@${EFFECT_VERSION}`, "", {}],
  "@effect/platform-bun": [
    `@effect/platform-bun@${EFFECT_VERSION}`,
    "",
    {
      dependencies: {
        "@effect/platform-node-shared": `^${EFFECT_VERSION}`,
      },
      peerDependencies: { effect: `^${EFFECT_VERSION}` },
    },
  ],
  "@effect/platform-node-shared": [
    `@effect/platform-node-shared@${EFFECT_VERSION}`,
    "",
    { peerDependencies: { effect: `^${EFFECT_VERSION}` } },
  ],
  "legacy/effect/fast-check": ["fast-check@3.23.2", "", {}],
  "legacy/@effect/platform-node-shared/ws": ["ws@8.18.0", "", {}],
};

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
    (value[1] !== undefined && typeof value[1] !== "string")
  ) {
    throw new TypeError(`bun.lock packages.${name} must be a package tuple`);
  }
  const metadata = value[2];
  return metadata === undefined
    ? { resolution: value[0] }
    : {
        metadata: objectValue(metadata, `bun.lock packages.${name} metadata`),
        resolution: value[0],
      };
}

function resolvedPackage(
  resolution: string,
  label: string,
): { name: string; version: string } {
  const versionSeparator = resolution.indexOf(
    "@",
    resolution[0] === "@" ? 1 : 0,
  );
  if (versionSeparator <= 0 || versionSeparator === resolution.length - 1) {
    throw new TypeError(`${label} has invalid resolution ${resolution}`);
  }
  return {
    name: resolution.slice(0, versionSeparator),
    version: resolution.slice(versionSeparator + 1),
  };
}

function resolvedVersion(packages: JsonObject, name: string): string {
  const resolution = packageEntry(packages, name).resolution;
  const resolved = resolvedPackage(resolution, `bun.lock packages.${name}`);
  if (resolved.name !== name) {
    throw new TypeError(
      `bun.lock packages.${name} has invalid resolution ${resolution}`,
    );
  }
  return resolved.version;
}

function isEffectPackage(name: string): boolean {
  return name === "effect" || name.startsWith("@effect/");
}

function effectAliasName(name: string): string | undefined {
  if (name === "effect" || name.endsWith("/effect")) return "effect";
  return name.match(/(?:^|\/)(@effect\/[^/]+)$/)?.[1];
}

function assertEffectClosure(packages: JsonObject): void {
  let effectPackageCount = 0;

  for (const name of Object.keys(packages)) {
    const label = `bun.lock packages.${name}`;
    const entry = packageEntry(packages, name);
    const resolved = resolvedPackage(entry.resolution, label);
    const aliasName = effectAliasName(name);
    const resolvedEffectName = isEffectPackage(resolved.name)
      ? resolved.name
      : undefined;

    if (aliasName && aliasName !== resolvedEffectName) {
      throw new Error(
        `${label} identifies ${aliasName} but resolves ${entry.resolution}`,
      );
    }

    if (resolvedEffectName) {
      effectPackageCount += 1;
      if (resolved.version !== EFFECT_VERSION) {
        throw new Error(
          `${label} resolves ${entry.resolution}; expected ${resolvedEffectName}@${EFFECT_VERSION}`,
        );
      }
    }

    if (!entry.metadata) continue;
    for (const field of EFFECT_RANGE_FIELDS) {
      const value = entry.metadata[field];
      if (value === undefined) continue;
      const ranges = objectValue(value, `${label}.${field}`);
      for (const [dependencyName, range] of Object.entries(ranges)) {
        if (!isEffectPackage(dependencyName)) continue;
        if (typeof range !== "string") {
          throw new TypeError(
            `${label}.${field}.${dependencyName} must be a string`,
          );
        }
        if (!Bun.semver.satisfies(EFFECT_VERSION, range)) {
          throw new Error(
            `${label}.${field}.${dependencyName} requires ${range}, which excludes ${EFFECT_VERSION}`,
          );
        }
      }
    }
  }

  if (effectPackageCount === 0) {
    throw new Error("bun.lock packages must resolve the Effect family");
  }
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

  assertEffectClosure(packages);
  expect(resolvedVersion(packages, "effect")).toBe(EFFECT_VERSION);
  expect(resolvedVersion(packages, "@smithers-orchestrator/engine")).toBe(
    SMITHERS_VERSION,
  );
});

test("nested package aliases cannot hide a second Effect closure", () => {
  expect(() => assertEffectClosure(EFFECT_CLOSURE_FIXTURE)).not.toThrow();

  expect(() =>
    assertEffectClosure({
      ...EFFECT_CLOSURE_FIXTURE,
      "legacy/effect": ["effect@3.22.1", "", {}],
    }),
  ).toThrow(
    `bun.lock packages.legacy/effect resolves effect@3.22.1; expected effect@${EFFECT_VERSION}`,
  );

  expect(() =>
    assertEffectClosure({
      ...EFFECT_CLOSURE_FIXTURE,
      "legacy/@effect/platform-node-shared": [
        "@effect/platform-node-shared@4.0.0-beta.107",
        "",
        {},
      ],
    }),
  ).toThrow(
    `bun.lock packages.legacy/@effect/platform-node-shared resolves @effect/platform-node-shared@4.0.0-beta.107; expected @effect/platform-node-shared@${EFFECT_VERSION}`,
  );
});

test("every Effect dependency range accepts the exact closure", () => {
  for (const field of EFFECT_RANGE_FIELDS) {
    expect(() =>
      assertEffectClosure({
        ...EFFECT_CLOSURE_FIXTURE,
        "range-holder": [
          "range-holder@1.0.0",
          "",
          { [field]: { effect: "^4.0.0-beta.107" } },
        ],
      }),
    ).toThrow(
      `bun.lock packages.range-holder.${field}.effect requires ^4.0.0-beta.107, which excludes ${EFFECT_VERSION}`,
    );
  }
});
