/**
 * Proves the baseline-free publish graph invariant and its publisher preflight:
 * no publishable package may ship a registry dependency on private/missing
 * workspace code, while private deployment packages remain outside the graph.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "../lib/spawn-sync-captured.mjs";
import { listPackages } from "../lib/workspaces.mjs";
import { main as publishFromDist } from "../publish-from-dist.mjs";
import {
  assertPublishableWorkspaceGraph,
  findUnpublishableWorkspaceDependencies,
  formatPublishGraphViolation,
  PublishGraphError,
} from "../verify-publish-graph.mjs";

const CHECK = fileURLToPath(
  new URL("../verify-publish-graph.mjs", import.meta.url),
);

function pkg(
  name: string,
  packageJson: Record<string, unknown>,
  dir = `packages/${name.replace(/^@[^/]+\//, "")}`,
) {
  return { name, dir, packageJson: { name, ...packageJson } };
}

describe("publishable workspace graph", () => {
  test("rejects private and missing installed workspace targets", () => {
    const graph = [
      pkg("@x/public", {
        dependencies: { "@x/private": "workspace:*" },
        optionalDependencies: { "@x/missing": "workspace:^" },
      }),
      pkg("@x/private", { private: true }),
    ];

    expect(findUnpublishableWorkspaceDependencies(graph)).toEqual([
      expect.objectContaining({
        dependency: "@x/private",
        field: "dependencies",
        reason: "private",
      }),
      expect.objectContaining({
        dependency: "@x/missing",
        field: "optionalDependencies",
        reason: "missing",
      }),
    ]);
  });

  test("rejects private and missing peer workspace targets", () => {
    const graph = [
      pkg("@x/public", {
        peerDependencies: {
          "@x/private": "workspace:*",
          "@x/missing": "workspace:^",
        },
      }),
      pkg("@x/private", { private: true }),
    ];

    expect(findUnpublishableWorkspaceDependencies(graph)).toEqual([
      expect.objectContaining({
        dependency: "@x/private",
        field: "peerDependencies",
        reason: "private",
      }),
      expect.objectContaining({
        dependency: "@x/missing",
        field: "peerDependencies",
        reason: "missing",
      }),
    ]);
  });

  test("ignores private owners, dev dependencies, and registry specs", () => {
    const graph = [
      pkg("@x/private-owner", {
        private: true,
        dependencies: { "@x/private": "workspace:*" },
      }),
      pkg("@x/public", {
        dependencies: { react: "^19.0.0" },
        devDependencies: { "@x/private": "workspace:*" },
      }),
      pkg("@x/private", { private: true }),
    ];

    expect(findUnpublishableWorkspaceDependencies(graph)).toEqual([]);
  });

  test("publisher fails before inspecting or packing dist artifacts", () => {
    const graph = [
      pkg("@x/public", {
        dependencies: { "@x/private": "workspace:*" },
      }),
      pkg("@x/private", { private: true }),
    ];

    expect(() =>
      publishFromDist({
        flags: { apply: false },
        packages: graph,
      }),
    ).toThrow(PublishGraphError);
  });

  test("live workspace graph has no unpublishable edge", () => {
    expect(() => assertPublishableWorkspaceGraph(listPackages())).not.toThrow();
  });

  test("node CLI executes the real check rather than silently exiting", () => {
    const output = execFileSync("node", [CHECK], { encoding: "utf8" });
    expect(output).toContain("[publish-graph] OK");
    expect(readFileSync(CHECK, "utf8")).toContain("process.argv[1]");
  });

  test("diagnostic identifies the consumer-breaking edge", () => {
    expect(
      formatPublishGraphViolation({
        from: "@x/public",
        fromDir: "packages/public",
        field: "dependencies",
        dependency: "@x/private",
        spec: "workspace:*",
        reason: "private",
        targetDir: "packages/private",
      }),
    ).toContain("target is private");
  });
});
