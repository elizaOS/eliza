/**
 * Guards the publish-graph contract (#15833): a published package must not pin
 * an unpublishable (`private: true` or absent) workspace package via
 * `workspace:*`, or the rewritten version 404s for external npm consumers. The
 * synthetic-graph cases drive the real guard logic; the repo case runs it
 * against the live workspace package.json set so the fix (un-privatizing
 * @elizaos/registry) is proven end-to-end.
 *
 * The CLI-entrypoint cases spawn the script via a real `node` child process
 * (not `bun`, not a direct import) so the #15939 regression — the bare
 * `import.meta.main` gate being a silent no-op under Node < 24.2 — cannot come
 * back: they assert the guard actually emits output and exits 0 on a clean tree
 * and non-zero on a seeded broken graph.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "../lib/workspaces.mjs";
import {
  classifyViolations,
  findDanglingWorkspaceDeps,
  formatViolation,
  loadBaselineKeys,
  runGuard,
  violationKey,
} from "../publish-graph-guard.mjs";

const GUARD = fileURLToPath(
  new URL("../publish-graph-guard.mjs", import.meta.url),
);

// Run the guard exactly the way the root `audit:publish-graph` script and CI do:
// via `node`, not `bun` (`process.execPath` is bun under bun:test, and bun always
// supported `import.meta.main` — spawning it would not exercise the #15939 fix).
function runGuardViaNode(baselinePath?: string) {
  try {
    const stdout = execFileSync("node", [GUARD], {
      encoding: "utf8",
      env: baselinePath
        ? { ...process.env, PUBLISH_GRAPH_BASELINE: baselinePath }
        : process.env,
    });
    return { code: 0, output: stdout };
  } catch (err) {
    // execFileSync throws with the child's exit status + captured streams.
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

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

  // Baseline/ratchet: the live graph carries pre-existing dangling edges beyond
  // the registry fix. classifyViolations must accept exactly the baselined ones,
  // reject anything new, and flag a baseline entry that no longer dangles.
  describe("baseline ratchet", () => {
    const priv = (name: string) =>
      pkg(name, { version: "1.0.0", private: true });
    const dep = (name: string, target: string) =>
      pkg(name, {
        version: "1.0.0",
        dependencies: { [target]: "workspace:*" },
      });

    test("accepts a baselined edge, rejects a new one", () => {
      const violations = findDanglingWorkspaceDeps([
        dep("@x/known", "@x/private-a"),
        priv("@x/private-a"),
        dep("@x/regression", "@x/private-b"),
        priv("@x/private-b"),
      ]);
      const baseline = new Set([violationKey(violations[0])]);
      const { newViolations, baselined, stale } = classifyViolations(
        violations,
        baseline,
      );
      expect(baselined.map((v) => v.from)).toEqual(["@x/known"]);
      expect(newViolations.map((v) => v.from)).toEqual(["@x/regression"]);
      expect(stale).toEqual([]);
    });

    test("violation keys are plain text: space-separated, no NUL bytes", () => {
      // The key separator was once a literal NUL byte, which made the guard
      // source read as binary to grep/diff/editors. npm package names and
      // dependency-field names can never contain a space, so a space-separated
      // key is equally collision-free — and this pins both the key format and
      // the file staying NUL-free.
      expect(
        violationKey({
          from: "@x/published",
          field: "dependencies",
          dependency: "@x/registry",
        }),
      ).toBe("@x/published dependencies @x/registry");
      expect(readFileSync(GUARD, "utf8")).not.toContain("\u0000");
    });

    test("flags a stale baseline entry that no longer dangles", () => {
      const { stale } = classifyViolations([], new Set(["@x/gone deps @x/x"]));
      expect(stale).toEqual(["@x/gone deps @x/x"]);
    });

    test("live graph is clean against the checked-in baseline", () => {
      // The real assertion behind `bun run audit:publish-graph` exiting 0.
      const { ok, newViolations, stale } = runGuard();
      expect(
        { newViolations, stale },
        `guard is not green:\n${newViolations.map(formatViolation).join("\n")}`,
      ).toMatchObject({ newViolations: [], stale: [] });
      expect(ok).toBe(true);
    });

    test("a missing baseline file fails closed (every edge is new)", () => {
      const keys = loadBaselineKeys(
        path.join(tmpdir(), "publish-graph-baseline.does-not-exist.json"),
      );
      expect(keys.size).toBe(0);
    });
  });

  // #15939 regression: the CLI entrypoint must actually run under `node`. Before
  // the fix, `node publish-graph-guard.mjs` was a silent no-op (exit 0, zero
  // output) on Node < 24.2 because the gate was bare `import.meta.main`. These
  // spawn the real script via `node` — the documented `audit:publish-graph`
  // invocation — and would fail if the entrypoint went inert again.
  describe("node CLI entrypoint (#15939)", () => {
    test("is not a silent no-op: emits output and exits 0 on the clean tree", () => {
      const { code, output } = runGuardViaNode();
      // A no-op produces zero bytes; the live guard always prints its verdict.
      expect(output).toContain("[publish-graph-guard]");
      expect(output).toContain(
        "OK — no NEW unpublishable workspace dependency",
      );
      expect(code).toBe(0);
    });

    test("exits non-zero and reports violations on a seeded broken graph", () => {
      // An empty baseline turns every pre-existing edge into a rejected new one,
      // so the same live graph that passes above must now fail loudly.
      const dir = mkdtempSync(path.join(tmpdir(), "publish-graph-guard-"));
      const emptyBaseline = path.join(dir, "empty-baseline.json");
      writeFileSync(emptyBaseline, JSON.stringify({ edges: [] }));
      const { code, output } = runGuardViaNode(emptyBaseline);
      expect(code).not.toBe(0);
      expect(output).toContain("NEW unpublishable workspace dependency");
    });

    test("source keeps the argv fallback so the gate is node-version-proof", () => {
      // Guards against a revert to the bare `import.meta.main` gate independently
      // of the node version the suite happens to run under (where both gates may
      // pass). The argv comparison is what makes it fire on Node < 24.2.
      const source = readFileSync(GUARD, "utf8");
      expect(source).toContain("process.argv[1]");
      expect(source).toContain("fileURLToPath(import.meta.url)");
    });
  });
});
