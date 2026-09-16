/**
 * Exercises real staged dependency graphs through fresh Node and Bun consumers after
 * removing their source packages. No filesystem or module-loader mocks.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stageColdPluginImportRoot } from "./plugin-resolver.ts";

let tmp: string;
let store: string;
let previous: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "staged-graph-"));
  store = path.join(tmp, "store");
  previous = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = path.join(tmp, "state");
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});
async function pkg(
  location: string,
  dependencies: Record<string, string>,
  source: string,
  name = location,
): Promise<string> {
  const dir = path.join(store, location);
  await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name,
      type: "module",
      exports: "./index.mjs",
      dependencies: Object.fromEntries(
        Object.keys(dependencies).map((d) => [d, "*"]),
      ),
    }),
  );
  await fs.writeFile(path.join(dir, "index.mjs"), source);
  for (const [dependency, target] of Object.entries(dependencies)) {
    await fs.mkdir(path.dirname(path.join(dir, "node_modules", dependency)), {
      recursive: true,
    });
    await fs.symlink(
      path.join(store, target),
      path.join(dir, "node_modules", dependency),
    );
  }
  return dir;
}
async function stageAndRun(
  root: string,
  entry = "index.mjs",
  runtime = process.execPath,
): Promise<{ staged: string; output: string }> {
  const manifest: { name: string } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const staged = await stageColdPluginImportRoot({
    installRoot: root,
    packageRoot: root,
    packageName: manifest.name,
    packageRelativePath: [],
  });
  await fs.rm(store, { recursive: true });
  return {
    staged,
    output: execFileSync(runtime, [path.join(staged, entry)], {
      encoding: "utf8",
    }).trim(),
  };
}
async function physicalPackages(root: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === "package.json" && entry.isFile()) count++;
    if (entry.isDirectory())
      count += await physicalPackages(path.join(root, entry.name));
    if (entry.isSymbolicLink()) {
      const link = path.join(root, entry.name);
      expect(path.isAbsolute(await fs.readlink(link))).toBe(false);
      const relative = path.relative(
        await fs.realpath(path.join(tmp, "state")),
        await fs.realpath(link),
      );
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative === ".." || relative.startsWith(`..${path.sep}`)).toBe(
        false,
      );
    }
  }
  return count;
}
it("preserves shared module identity across a dependency diamond", async () => {
  await pkg("shared-leaf", {}, "export const identity = {};");
  await pkg(
    "left",
    { "shared-leaf": "shared-leaf" },
    "export { identity } from 'shared-leaf';",
  );
  await pkg(
    "right",
    { "shared-leaf": "shared-leaf" },
    "export { identity } from 'shared-leaf';",
  );
  const root = await pkg(
    "graph-root",
    { left: "left", right: "right" },
    "import { identity as left } from 'left'; import { identity as right } from 'right'; console.log(JSON.stringify({same: left === right}));",
  );
  const { output, staged } = await stageAndRun(root);
  expect(JSON.parse(output)).toEqual({ same: true });
  expect(await physicalPackages(staged)).toBe(4);
});
it("retains one physical package per resolved identity through repeated diamonds", async () => {
  await pkg("leaf", {}, "export const identities = [{}];");
  let dependencies: Record<string, string> = { leaf: "leaf" };
  let source = "export { identities } from 'leaf';";
  for (let level = 0; level < 4; level++) {
    const left = `left-${level}`;
    const right = `right-${level}`;
    await pkg(left, dependencies, source);
    await pkg(right, dependencies, source);
    dependencies = { [left]: left, [right]: right };
    source = `import { identities as left } from '${left}'; import { identities as right } from '${right}'; export const identities = [...left,...right];`;
  }
  const root = await pkg(
    "graph-root",
    dependencies,
    `${source} console.log(new Set(identities).size);`,
  );
  const { output, staged } = await stageAndRun(root);
  expect(output).toBe("1");
  expect(await physicalPackages(staged)).toBe(10);
});
it("preserves cycles without duplicating a module instance", async () => {
  await pkg(
    "a",
    { b: "b" },
    "import { getA } from 'b'; export const identity = {}; export function check() { return getA() === identity; }",
  );
  await pkg(
    "b",
    { a: "a" },
    "import { identity } from 'a'; export function getA() { return identity; }",
  );
  const root = await pkg(
    "graph-root",
    { a: "a" },
    "import { check } from 'a'; console.log(check());",
  );
  const { output, staged } = await stageAndRun(root);
  expect(output).toBe("true");
  expect(await physicalPackages(staged)).toBe(3);
});
it("keeps distinct versions and their package-relative assets isolated", async () => {
  for (const version of ["one", "two"]) {
    const dir = await pkg(
      `version-${version}`,
      {},
      "import { readFileSync } from 'node:fs'; export const value = readFileSync(new URL('./asset.txt', import.meta.url), 'utf8');",
      "versioned",
    );
    await fs.writeFile(path.join(dir, "asset.txt"), version);
    await pkg(
      version,
      { versioned: `version-${version}` },
      "export { value } from 'versioned';",
    );
  }
  const root = await pkg(
    "graph-root",
    { one: "one", two: "two" },
    "import { value as one } from 'one'; import { value as two } from 'two'; console.log(JSON.stringify([one,two]));",
  );
  const { output, staged } = await stageAndRun(root);
  expect(JSON.parse(output)).toEqual(["one", "two"]);
  expect(await physicalPackages(staged)).toBe(5);
});

it("keeps full and source-staged package modes distinct through a cycle", async () => {
  await pkg(
    "bridge",
    { "@elizaos/agent": "agent" },
    "export { marker } from '@elizaos/agent/probe';",
  );
  await pkg("marker", {}, "export const marker = 'source dependency';");
  const root = await pkg(
    "agent",
    { bridge: "bridge", marker: "marker" },
    "import { marker } from 'bridge'; console.log(marker);",
    "@elizaos/agent",
  );
  const sourceFiles = [
    "actions/extract-params.ts",
    "actions/grounded-action-reply.ts",
    "api/conversation-metadata.ts",
    "api/connector-account-routes.ts",
    "api/rate-limiter.ts",
    "config/config.ts",
    "config/owner-contacts.ts",
    "config/paths.ts",
    "diagnostics/integration-observability.ts",
    "runtime/agent-event-service.ts",
    "runtime/owner-entity.ts",
    "security/access.ts",
    "services/app-session-gate.ts",
    "services/escalation.ts",
    "triggers/scheduling.ts",
    "triggers/runtime.ts",
  ];
  for (const file of sourceFiles) {
    const target = path.join(root, "src", file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "export {};\n");
  }
  await fs.mkdir(path.join(root, "dist"));
  await fs.copyFile(
    path.join(root, "index.mjs"),
    path.join(root, "dist/index.js"),
  );
  await fs.writeFile(
    path.join(root, "dist/probe.js"),
    "export const marker = 'full dependency';",
  );
  await fs.writeFile(
    path.join(root, "src/probe.ts"),
    "export { marker } from 'marker';",
  );
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.exports = { ".": "./dist/index.js", "./probe": "./dist/probe.js" };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const { output } = await stageAndRun(root, "dist/index.js", "bun");
  expect(output).toBe("source dependency");
});
