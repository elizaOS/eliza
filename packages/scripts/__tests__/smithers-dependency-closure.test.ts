/**
 * Audits the resolved Smithers runtime graph against the host versions and
 * keeps known-incompatible optional backends visibly disabled.
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
  expect(overrides["@effect/platform-node-shared"]).toBe(
    "4.0.0-beta.102",
  );

  const lock = object(
    Bun.JSONC.parse(readFileSync(path.join(repoRoot, "bun.lock"), "utf8")),
    "bun.lock",
  );
  const packages = object(lock.packages, "bun.lock.packages");
  for (const [key, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
    const resolution = raw[0];
    if (
      resolution.startsWith("effect@") ||
      resolution.startsWith("@effect/")
    ) {
      expect(versionOf(resolution), key).toBe("4.0.0-beta.102");
    }
  }

  const engine = packageTuple(packages, "@smithers-orchestrator/engine");
  const engineDependencies = object(engine[2]?.dependencies, "Smithers deps");
  expect(Bun.semver.satisfies(hostReact, String(engineDependencies.react))).toBe(
    true,
  );
  expect(
    Bun.semver.satisfies(hostReact, String(engineDependencies["react-dom"])),
  ).toBe(true);
});

test("the incompatible Smithers PGlite backend remains fail-closed", () => {
  const lock = object(
    Bun.JSONC.parse(readFileSync(path.join(repoRoot, "bun.lock"), "utf8")),
    "bun.lock",
  );
  const packages = object(lock.packages, "bun.lock.packages");
  const pglite = packageTuple(
    packages,
    "@smithers-orchestrator/engine/@electric-sql/pglite",
  );
  const socket = packageTuple(
    packages,
    "@smithers-orchestrator/engine/@electric-sql/pglite-socket",
  );
  const socketPeers = object(socket[2]?.peerDependencies, "socket peers");
  const pgliteVersion = versionOf(pglite[0]);
  const socketRange = String(socketPeers["@electric-sql/pglite"]);
  expect(Bun.semver.satisfies(pgliteVersion, socketRange)).toBe(false);

  const workflowRuntime = readFileSync(
    path.join(
      repoRoot,
      "plugins/plugin-workflow/src/services/smithers-runtime.ts",
    ),
    "utf8",
  );
  expect(workflowRuntime).toContain("SMITHERS_PGLITE_VERSION_INCOMPATIBLE");
});
