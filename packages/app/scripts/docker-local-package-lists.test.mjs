/** Tests manifest-driven Docker runtime closure with real isolated workspace manifests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDockerWorkspaceDirs } from "./collect-docker-runtime-deps.mjs";

const roots = [];
function workspace(packages) {
  const root = mkdtempSync(path.join(os.tmpdir(), "docker-closure-"));
  roots.push(root);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  for (const [directory, manifest] of Object.entries(packages)) {
    const dir = path.join(root, "packages", directory);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Docker runtime dependency closure", () => {
  it("includes transitive and cyclic runtime dependencies once, without development or optional dependencies", () => {
    const root = workspace({
      agent: {
        name: "@elizaos/agent",
        dependencies: { "@elizaos/sql": "workspace:*" },
        devDependencies: { "dev-only": "workspace:*" },
        optionalDependencies: { "optional-only": "workspace:*" },
        peerDependencies: { "optional-peer": "workspace:*" },
        peerDependenciesMeta: { "optional-peer": { optional: true } },
      },
      sql: {
        name: "@elizaos/sql",
        dependencies: { "@elizaos/core": "workspace:*", pg: "8.23.0" },
      },
      core: {
        name: "@elizaos/core",
        dependencies: { "@elizaos/sql": "workspace:*" },
      },
    });
    expect(
      collectDockerWorkspaceDirs(root, ["packages/agent"]).map((dir) =>
        path.relative(root, dir),
      ),
    ).toEqual(["packages/agent", "packages/sql", "packages/core"]);
  });

  it("fails with the owning consumer when a declared runtime workspace is absent", () => {
    const root = workspace({
      agent: {
        name: "@elizaos/agent",
        dependencies: { "@elizaos/missing": "workspace:*" },
      },
    });
    expect(() => collectDockerWorkspaceDirs(root, ["packages/agent"])).toThrow(
      "Missing runtime workspace @elizaos/missing required by @elizaos/agent",
    );
  });

  it("keeps UI linked without expanding its browser-only dependency tree", () => {
    const root = workspace({
      agent: {
        name: "@elizaos/agent",
        dependencies: { "@elizaos/ui": "workspace:*" },
      },
      ui: {
        name: "@elizaos/ui",
        dependencies: { "browser-only": "workspace:*" },
      },
    });
    expect(
      collectDockerWorkspaceDirs(root, ["packages/agent"]).map((dir) =>
        path.relative(root, dir),
      ),
    ).toEqual(["packages/agent", "packages/ui"]);
  });
});
