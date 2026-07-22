/**
 * Verifies Feed's nested workspace includes the local dependencies required by
 * every external elizaOS package it links from the repository workspace.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[];
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FEED_ROOT = join(REPOSITORY_ROOT, "packages", "feed");

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

test("Feed external workspaces form a closed local dependency set", () => {
  const feedManifest = readManifest(join(FEED_ROOT, "package.json"));
  const externalManifests = (feedManifest.workspaces ?? [])
    .filter((workspace) => workspace.startsWith("../"))
    .map((workspace) => {
      const path = resolve(FEED_ROOT, workspace, "package.json");
      return { path, manifest: readManifest(path) };
    });
  const availablePackages = new Set(
    externalManifests.map(({ manifest }) => manifest.name),
  );
  const missingDependencies: string[] = [];

  for (const { path, manifest } of externalManifests) {
    const dependencyGroups = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ];
    for (const dependencies of dependencyGroups) {
      for (const [dependency, version] of Object.entries(dependencies ?? {})) {
        if (
          version.startsWith("workspace:") &&
          dependency.startsWith("@elizaos/") &&
          !availablePackages.has(dependency)
        ) {
          missingDependencies.push(
            `${manifest.name} (${dirname(path)}) requires ${dependency}`,
          );
        }
      }
    }
  }

  expect(missingDependencies).toEqual([]);
});
