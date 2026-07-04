/**
 * Zero-edit proof for the script-decoupling work (#12334/#12336): adding or
 * removing a plugin changes what the generic scripts discover — core-build set,
 * test lanes, serial set, dev-stack, scenario roots, and the coupling gate —
 * purely by editing that plugin's own package.json and files, with the script
 * sources under `packages/scripts/` byte-for-byte untouched.
 *
 * Fixtures are throwaway temp repos passed to the real resolvers via
 * `{ repoRoot }`, and the coupling gate is exercised by spawning the real
 * `audit-scripts.mjs --root <fixture>`. Deterministic; no network.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCoreBuildPackages,
  resolveDevAllSkipPlugins,
  resolveTestLaneDirs,
  resolveTestSerialPackages,
} from "../lib/script-metadata.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const AUDIT_SCRIPT = path.join(SCRIPT_DIR, "..", "audit-scripts.mjs");

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-zero-edit-"));
  tempRoots.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      { type: "module", workspaces: ["packages/*", "plugins/*"] },
      null,
      2,
    ),
  );
  return root;
}

function writePackage(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
): void {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(
    path.join(full, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
}

/** Add a plugin with `test/scenarios` + the given elizaos.scripts metadata. */
function writePlugin(
  root: string,
  name: string,
  scripts: Record<string, unknown>,
): void {
  const dir = path.join("plugins", name.replace("@elizaos/", ""));
  writePackage(root, dir, { name, elizaos: { scripts } });
  const scenarioDir = path.join(root, dir, "test", "scenarios");
  fs.mkdirSync(scenarioDir, { recursive: true });
  fs.writeFileSync(
    path.join(scenarioDir, "smoke.scenario.ts"),
    "export default {};\n",
  );
}

/** Discover the `test/scenarios` roots the way build-manifest.mjs now does. */
function discoverScenarioRoots(root: string): Promise<string[]> {
  return import(
    path.join(REPO_ROOT, "packages/scripts/lib/workspaces.mjs")
  ).then(
    (mod: { listPackages: (o: { repoRoot: string }) => { dir: string }[] }) =>
      mod
        .listPackages({ repoRoot: root })
        .map((p) => path.posix.join(p.dir, "test", "scenarios"))
        .filter((rel) => fs.existsSync(path.join(root, rel)))
        .sort((a, b) => a.localeCompare(b)),
  );
}

function runCouplingAudit(root: string): {
  ok: boolean;
  failures: string[];
} {
  const result = spawnSync(
    process.execPath,
    [AUDIT_SCRIPT, "--root", root, "--json"],
    { encoding: "utf8" },
  );
  if (!result.stdout) {
    throw new Error(result.stderr || "audit-scripts produced no output");
  }
  return JSON.parse(result.stdout);
}

/** Snapshot every script source's bytes so we can prove none were edited. */
function snapshotScriptSources(): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js|mts|cts|ts|tsx)$/.test(entry.name))
        snapshot.set(full, fs.readFileSync(full, "utf8"));
    }
  };
  walk(path.join(REPO_ROOT, "packages", "scripts"));
  walk(path.join(REPO_ROOT, "scripts"));
  return snapshot;
}

describe("plugin discovery is zero-edit", () => {
  test("adding then removing a plugin flips every resolved set with no script edit", async () => {
    const before = snapshotScriptSources();

    const root = makeRepo();
    // A minimal base so lanes/serial have something to resolve against.
    writePackage(root, "packages/core", {
      name: "@elizaos/core",
      elizaos: { scripts: { coreBuild: true, testLanes: ["server"] } },
    });

    // Absent to begin with.
    expect(resolveCoreBuildPackages({ repoRoot: root })).not.toContain(
      "@elizaos/plugin-zeta",
    );
    expect([...resolveTestSerialPackages({ repoRoot: root })]).not.toContain(
      "@elizaos/plugin-zeta",
    );
    expect(resolveTestLaneDirs("client", { repoRoot: root })).toHaveLength(0);
    expect(await discoverScenarioRoots(root)).not.toContain(
      "plugins/plugin-zeta/test/scenarios",
    );

    // Add the plugin purely by writing ITS package.json + files.
    writePlugin(root, "@elizaos/plugin-zeta", {
      coreBuild: true,
      testSerial: true,
      testLanes: ["client"],
      devStack: { skipInDevAll: true },
    });

    // Every generic script's resolved set now includes it — no script edited.
    expect(resolveCoreBuildPackages({ repoRoot: root })).toContain(
      "@elizaos/plugin-zeta",
    );
    expect([...resolveTestSerialPackages({ repoRoot: root })]).toContain(
      "@elizaos/plugin-zeta",
    );
    expect(resolveTestLaneDirs("client", { repoRoot: root })).toContain(
      "plugins/plugin-zeta",
    );
    expect(resolveDevAllSkipPlugins({ repoRoot: root })).toContain(
      "@elizaos/plugin-zeta",
    );
    expect(await discoverScenarioRoots(root)).toContain(
      "plugins/plugin-zeta/test/scenarios",
    );

    // Remove the plugin — resolved sets shrink back, still no script edit.
    fs.rmSync(path.join(root, "plugins", "plugin-zeta"), {
      recursive: true,
      force: true,
    });
    expect(resolveCoreBuildPackages({ repoRoot: root })).not.toContain(
      "@elizaos/plugin-zeta",
    );
    expect([...resolveTestSerialPackages({ repoRoot: root })]).not.toContain(
      "@elizaos/plugin-zeta",
    );
    expect(resolveTestLaneDirs("client", { repoRoot: root })).toHaveLength(0);
    expect(await discoverScenarioRoots(root)).not.toContain(
      "plugins/plugin-zeta/test/scenarios",
    );

    // Not a single script source byte changed across the whole exercise.
    const after = snapshotScriptSources();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, bytes] of before) {
      expect(after.get(file)).toBe(bytes);
    }
  });

  test("the coupling gate reacts to plugin tokens without a script edit", () => {
    const root = makeRepo();
    writePackage(root, "packages/scripts", { name: "fixture-scripts" });

    // A generic script that discovers via the seam — no plugin tokens — passes.
    fs.writeFileSync(
      path.join(root, "packages", "scripts", "clean.ts"),
      "import { listPackages } from './lib/workspaces.mjs';\nexport const x = listPackages();\n",
    );
    expect(runCouplingAudit(root).ok).toBe(true);

    // Introduce a hardcoded plugin token in a generic script → the gate fails.
    fs.writeFileSync(
      path.join(root, "packages", "scripts", "coupled.ts"),
      'export const SKIP = ["@elizaos/plugin-omega"];\n',
    );
    const coupled = runCouplingAudit(root);
    expect(coupled.ok).toBe(false);
    expect(coupled.failures.some((f) => f.includes("[coupling]"))).toBe(true);

    // Allowlisting the file+token with a reason clears it — no script edit.
    fs.writeFileSync(
      path.join(
        root,
        "packages",
        "scripts",
        "script-plugin-coupling.allowlist.json",
      ),
      JSON.stringify([
        {
          file: "packages/scripts/coupled.ts",
          tokens: ["@elizaos/plugin-omega"],
          reason: "systemic: fixture exercises the omega plugin by name",
        },
      ]),
    );
    expect(runCouplingAudit(root).ok).toBe(true);

    // A stale allowlist entry (token gone from the file) fails again.
    fs.writeFileSync(
      path.join(root, "packages", "scripts", "coupled.ts"),
      'export const SKIP = ["@elizaos/plugin-sigma"];\n',
    );
    const stale = runCouplingAudit(root);
    expect(stale.ok).toBe(false);
    expect(stale.failures.some((f) => f.includes("[coupling-stale]"))).toBe(
      true,
    );
  });
});
