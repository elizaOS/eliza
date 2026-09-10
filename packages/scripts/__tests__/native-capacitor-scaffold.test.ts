/**
 * Proves generated native Capacitor build files cannot drift while capability contracts remain package-owned.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectNativeCapacitorScaffoldDrift,
  loadNativeCapacitorScaffoldManifest,
  writeNativeCapacitorScaffold,
} from "../native-capacitor-scaffold.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native Capacitor scaffold", () => {
  it("keeps every governed package aligned with the canonical generator", () => {
    expect(collectNativeCapacitorScaffoldDrift(REPO_ROOT)).toEqual([]);
  });

  it("detects and repairs generated build drift", () => {
    const root = mkdtempSync(path.join(tmpdir(), "native-capacitor-scaffold-"));
    temporaryRoots.push(root);
    const manifest = loadNativeCapacitorScaffoldManifest();
    for (const packageName of new Set([
      ...manifest.tsconfigFamilies.flatMap((family) => family.packages),
      ...manifest.rollupPackages.map((entry) => entry.packageName),
    ])) {
      mkdirSync(path.join(root, "plugins", packageName), { recursive: true });
    }
    writeNativeCapacitorScaffold(root);

    const drifted = path.join(
      root,
      "plugins",
      manifest.rollupPackages[0].packageName,
      "rollup.config.mjs",
    );
    writeFileSync(drifted, "export default {};\n");
    expect(collectNativeCapacitorScaffoldDrift(root)).toEqual([
      path.relative(root, drifted),
    ]);

    writeNativeCapacitorScaffold(root);
    expect(collectNativeCapacitorScaffoldDrift(root)).toEqual([]);
  });
});
