/**
 * Audits the resolved Smithers runtime graph against the host versions.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

type JsonObject = Record<string, unknown>;
type PackageTuple = [string, string?, JsonObject?];

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function packageTuple(packages: JsonObject, key: string): PackageTuple {
  const value = packages[key];
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    throw new TypeError(`bun.lock packages.${key} must be a package tuple`);
  }
  return value as PackageTuple;
}

function versionOf(resolution: string): string {
  const separator = resolution.indexOf("@", resolution.startsWith("@") ? 1 : 0);
  if (separator < 1) throw new TypeError(`invalid resolution ${resolution}`);
  return resolution.slice(separator + 1);
}

test("Smithers uses one peer-compatible Effect and React closure", () => {
  const manifest = object(
    JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")),
    "package.json",
  );
  const dependencies = object(manifest.devDependencies, "devDependencies");
  const overrides = object(manifest.overrides, "overrides");
  const hostReact = String(dependencies.react);
  expect(hostReact).toBe("19.2.7");
  expect(dependencies["react-dom"]).toBe(hostReact);
  expect(overrides["@effect/platform-node-shared"]).toBe("4.0.0-beta.105");

  const lock = object(
    Bun.JSONC.parse(readFileSync(path.join(repoRoot, "bun.lock"), "utf8")),
    "bun.lock",
  );
  const packages = object(lock.packages, "bun.lock.packages");
  for (const [key, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
    const resolution = raw[0];
    if (resolution.startsWith("effect@") || resolution.startsWith("@effect/")) {
      expect(versionOf(resolution), key).toBe("4.0.0-beta.105");
    }
  }

  const engine = packageTuple(packages, "@smthrs/engine");
  const engineDependencies = object(engine[2]?.dependencies, "Smithers deps");
  expect(
    Bun.semver.satisfies(hostReact, String(engineDependencies.react)),
  ).toBe(true);
  expect(
    Bun.semver.satisfies(hostReact, String(engineDependencies["react-dom"])),
  ).toBe(true);
});

test("Smithers PGlite closure remains peer-compatible and enabled", () => {
  const manifest = object(
    JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")),
    "package.json",
  );
  const resolutions = object(manifest.resolutions, "resolutions");
  const overrides = object(manifest.overrides, "overrides");
  expect(resolutions).not.toHaveProperty("@electric-sql/pglite");
  expect(overrides).not.toHaveProperty("@electric-sql/pglite");

  for (const pluginManifestPath of [
    "plugins/plugin-agent-orchestrator/package.json",
    "plugins/plugin-workflow/package.json",
  ]) {
    const pluginManifest = object(
      JSON.parse(readFileSync(path.join(repoRoot, pluginManifestPath), "utf8")),
      pluginManifestPath,
    );
    const dependencies = object(
      pluginManifest.dependencies,
      `${pluginManifestPath} dependencies`,
    );
    expect(dependencies.smthrs, pluginManifestPath).toBe("0.34.0");
  }

  const lock = object(
    Bun.JSONC.parse(readFileSync(path.join(repoRoot, "bun.lock"), "utf8")),
    "bun.lock",
  );
  const packages = object(lock.packages, "bun.lock.packages");
  const engine = packageTuple(packages, "@smthrs/engine");
  expect(versionOf(engine[0])).toBe("0.34.0");
  const optionalDependencies = object(
    engine[2]?.optionalDependencies,
    "Smithers optional deps",
  );
  expect(optionalDependencies["@electric-sql/pglite"]).toBe("^0.5.4");
  expect(optionalDependencies["@electric-sql/pglite-socket"]).toBe("^0.2.6");

  const pglite = packageTuple(packages, "@smthrs/engine/@electric-sql/pglite");
  const socket = packageTuple(
    packages,
    "@smthrs/engine/@electric-sql/pglite-socket",
  );
  const pgliteVersion = versionOf(pglite[0]);
  const socketVersion = versionOf(socket[0]);
  const socketPeers = object(socket[2]?.peerDependencies, "socket peers");
  expect(
    Bun.semver.satisfies(
      pgliteVersion,
      String(optionalDependencies["@electric-sql/pglite"]),
    ),
  ).toBe(true);
  expect(
    Bun.semver.satisfies(
      socketVersion,
      String(optionalDependencies["@electric-sql/pglite-socket"]),
    ),
  ).toBe(true);
  expect(
    Bun.semver.satisfies(
      pgliteVersion,
      String(socketPeers["@electric-sql/pglite"]),
    ),
  ).toBe(true);

  const runner = readFileSync(
    path.join(
      repoRoot,
      "plugins/plugin-agent-orchestrator/src/services/smithers-task-runner.ts",
    ),
    "utf8",
  );
  expect(runner).not.toContain("SMITHERS_PGLITE_INCOMPATIBLE");
  expect(runner).toContain("Smithers.pglite");
});
