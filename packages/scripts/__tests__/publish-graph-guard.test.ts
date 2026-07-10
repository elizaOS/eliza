// Guards the publish-graph contract (#15833): a published package must not pin
// an unpublishable (`private: true` or absent) workspace package via
// `workspace:*`, or the rewritten version 404s for external npm consumers. The
// synthetic-graph cases drive the real guard logic; the repo case runs it
// against the live workspace package.json set so the fix (un-privatizing
// @elizaos/registry) is proven end-to-end.
import { describe, expect, test } from "bun:test";
import { listPackages } from "../lib/workspaces.mjs";
import {
  findDanglingWorkspaceDeps,
  formatViolation,
} from "../publish-graph-guard.mjs";

function pkg(
  name,
  packageJson,
  dir = `packages/${name.replace(/^@[^/]+\//, "")}`,
) {
  return { name, dir, packageJson: { name, ...packageJson } };
}

describe("publish-graph guard (#15833)", () => {
  test("flags a published package that pins a private workspace dep", () => {
    const graph = [
      pkg("@x/published", {
        version: "1.0.0",
        dependencies: { "@x/registry": "workspace:*" },
      }),
      pkg("@x/registry", { version: "1.0.0", private: true }),
    ];
    const violations = findDanglingWorkspaceDeps(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      from: "@x/published",
      dependency: "@x/registry",
      field: "dependencies",
      reason: "private",
    });
    expect(formatViolation(violations[0])).toContain('"private": true');
  });

  test("passes once the target is publishable", () => {
    const graph = [
      pkg("@x/published", {
        version: "1.0.0",
        dependencies: { "@x/registry": "workspace:*" },
      }),
      pkg("@x/registry", { version: "1.0.0" }),
    ];
    expect(findDanglingWorkspaceDeps(graph)).toHaveLength(0);
  });

  test("flags a workspace:* dep with no matching workspace package", () => {
    const graph = [
      pkg("@x/published", {
        version: "1.0.0",
        dependencies: { "@x/ghost": "workspace:*" },
      }),
    ];
    const violations = findDanglingWorkspaceDeps(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("missing");
  });

  test("flags optionalDependencies, ignores dev/peer and non-workspace specs", () => {
    const graph = [
      pkg("@x/published", {
        version: "1.0.0",
        dependencies: { react: "^19.0.0" },
        optionalDependencies: { "@x/registry": "workspace:*" },
        peerDependencies: { "@x/registry": "workspace:*" },
        devDependencies: { "@x/registry": "workspace:*" },
      }),
      pkg("@x/registry", { version: "1.0.0", private: true }),
    ];
    const violations = findDanglingWorkspaceDeps(graph);
    expect(violations).toHaveLength(1);
    expect(violations[0].field).toBe("optionalDependencies");
  });

  test("a private package may itself pin a private workspace dep", () => {
    // Only publishable packages are audited; private packages never ship.
    const graph = [
      pkg("@x/internal", {
        version: "1.0.0",
        private: true,
        dependencies: { "@x/registry": "workspace:*" },
      }),
      pkg("@x/registry", { version: "1.0.0", private: true }),
    ];
    expect(findDanglingWorkspaceDeps(graph)).toHaveLength(0);
  });

  // The #15833 regression, driven over the real workspace package.json graph:
  // before @elizaos/registry was un-privatized this set contained a
  // @elizaos/registry edge (published @elizaos/shared / agent / app-core pin it
  // via workspace:*); after the fix it must not. Scoped to the registry edge
  // rather than the whole graph because the guard also surfaces pre-existing
  // dangling edges tracked as separate follow-up.
  test("@elizaos/registry is no longer a dangling published dependency (#15833)", () => {
    const violations = findDanglingWorkspaceDeps(listPackages());
    const registryEdges = violations.filter(
      (v) => v.dependency === "@elizaos/registry",
    );
    expect(
      registryEdges,
      `@elizaos/registry still dangles:\n${registryEdges.map(formatViolation).join("\n")}`,
    ).toEqual([]);
  });
});
