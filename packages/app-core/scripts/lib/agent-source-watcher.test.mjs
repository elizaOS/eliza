/** Exercises agent source watcher behavior with deterministic app-core test fixtures. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectAgentSourceDirs,
  isReloadableChangePath,
  startAgentSourceWatcher,
} from "./agent-source-watcher.mjs";
import { resolveElizaWorkspaceRootFromImportMeta } from "./repo-root.mjs";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

function removePathRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(40);
  }
  return predicate();
}

describe("collectAgentSourceDirs", () => {
  let root = null;
  afterEach(() => {
    if (root) removePathRecursive(root);
    root = null;
  });

  it("includes backend packages + all plugins, excludes frontend + src-less dirs", () => {
    root = mkdtempSync(path.join(tmpdir(), "agent-watch-"));
    const mk = (...p) => mkdirSync(path.join(root, ...p), { recursive: true });
    mk("packages", "core", "src");
    mk("packages", "agent", "src");
    mk("packages", "ui", "src"); // frontend → excluded
    mk("packages", "app", "src"); // frontend → excluded
    mk("packages", "no-src"); // has no src → excluded
    mk("plugins", "plugin-app-control", "src");
    mk("plugins", "plugin-x", "src");

    const dirs = collectAgentSourceDirs(root)
      .map((d) => path.relative(root, d).split(path.sep).join("/"))
      .sort();
    expect(dirs).toEqual([
      "packages/agent/src",
      "packages/core/src",
      "plugins/plugin-app-control/src",
      "plugins/plugin-x/src",
    ]);
  });

  it("returns [] when packages/ and plugins/ are absent", () => {
    root = mkdtempSync(path.join(tmpdir(), "agent-watch-empty-"));
    expect(collectAgentSourceDirs(root)).toEqual([]);
  });
});

describe("isReloadableChangePath", () => {
  it("reloads for hand-written TS source + json the agent loads", () => {
    for (const p of [
      "/r/plugins/plugin-app-control/src/actions/views.ts",
      "/r/packages/agent/src/api/server.ts",
      "/r/packages/core/src/runtime/x.tsx",
      "/r/packages/core/src/runtime/y.mts",
      "/r/plugins/p/src/registry.json",
    ]) {
      expect(isReloadableChangePath(p)).toBe(true);
    }
  });

  it("does NOT react to compiled .js / .d.ts shadows next to source", () => {
    // This monorepo emits .js/.d.ts into src/; reacting would bounce the agent
    // on every build.
    for (const p of [
      "/r/packages/core/src/runtime/views.js",
      "/r/packages/core/src/runtime/views.mjs",
      "/r/packages/core/src/runtime/views.d.ts",
      "/r/packages/core/src/runtime/views.d.mts",
    ]) {
      expect(isReloadableChangePath(p)).toBe(false);
    }
  });

  it("ignores build output, deps, generated, and test/coverage dirs", () => {
    for (const p of [
      "/r/packages/core/dist/index.ts",
      "/r/packages/core/src/node_modules/x/y.ts",
      "/r/packages/core/src/__tests__/a.ts",
      "/r/packages/core/src/generated/data.ts",
      "/r/packages/core/.turbo/log.json",
      "/r/packages/core/coverage/lcov.ts",
    ]) {
      expect(isReloadableChangePath(p)).toBe(false);
    }
  });

  it("ignores co-located test/spec files and non-code files", () => {
    for (const p of [
      "/r/packages/core/src/views.test.ts",
      "/r/packages/core/src/views.spec.tsx",
      "/r/packages/core/src/readme.md",
      "/r/packages/core/src/styles.css",
    ]) {
      expect(isReloadableChangePath(p)).toBe(false);
    }
  });

  it("treats an unknown (null/undefined) filename as reloadable", () => {
    expect(isReloadableChangePath(null)).toBe(true);
    expect(isReloadableChangePath(undefined)).toBe(true);
  });
});

describe("startAgentSourceWatcher (integration)", () => {
  let root = null;
  let handle = null;
  afterEach(() => {
    if (handle) handle.close();
    handle = null;
    if (root) removePathRecursive(root);
    root = null;
  });

  it("fires onChange (debounced) for a real backend src edit", async () => {
    root = mkdtempSync(path.join(tmpdir(), "agent-watch-int-"));
    const mk = (...p) => mkdirSync(path.join(root, ...p), { recursive: true });
    mk("plugins", "plugin-app-control", "src", "actions");
    mk("packages", "ui", "src"); // frontend → not among watched dirs

    const calls = [];
    handle = startAgentSourceWatcher({
      root,
      debounceMs: 60,
      onChange: (rel, count) => calls.push({ rel, count }),
    });
    // Only the plugin src is watched; the frontend package is excluded.
    expect(handle.count).toBe(1);

    await delay(200); // let the OS watcher arm before the first write
    writeFileSync(
      path.join(root, "plugins/plugin-app-control/src/actions/views.ts"),
      "export const x = 1;\n",
    );

    const fired = await waitUntil(() => calls.length > 0, 4000);
    expect(fired).toBe(true);
    expect(calls.some((c) => c.rel.includes("views.ts"))).toBe(true);
    // A single edit reports a small changed-count (the bulk guard keys on this).
    expect(calls.every((c) => c.count <= 2)).toBe(true);
  });

  it("reloads an opted-in flat provider model edit without reacting to build output", async () => {
    root = mkdtempSync(path.join(tmpdir(), "agent-watch-flat-"));
    const pluginRoot = path.join(root, "plugins", "plugin-flat-provider");
    for (const dir of ["models", "dist", "node_modules", "__tests__"]) {
      mkdirSync(path.join(pluginRoot, dir), { recursive: true });
    }
    writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-flat-provider",
        type: "module",
        exports: { ".": "./dist/index.node.js" },
        elizaos: { plugin: { workspaceSource: { ".": "./index.node.ts" } } },
      }),
    );
    writeFileSync(
      path.join(pluginRoot, "index.node.ts"),
      'export { model } from "./models/text.ts";\n',
    );
    const modelPath = path.join(pluginRoot, "models", "text.ts");
    writeFileSync(modelPath, "export const model = 'before';\n");

    const partialRoot = path.join(root, "plugins", "plugin-partial");
    mkdirSync(partialRoot);
    writeFileSync(
      path.join(partialRoot, "package.json"),
      JSON.stringify({
        elizaos: { plugin: { workspaceSource: { ".": "./missing.ts" } } },
      }),
    );
    const disabledRoot = path.join(root, "plugins", "plugin-disabled");
    mkdirSync(disabledRoot);
    writeFileSync(
      path.join(disabledRoot, "package.json"),
      JSON.stringify({
        elizaos: { plugin: { workspaceSource: false } },
      }),
    );
    writeFileSync(
      path.join(disabledRoot, "index.node.ts"),
      "export const disabled = true;\n",
    );

    const calls = [];
    const errors = [];
    handle = startAgentSourceWatcher({
      root,
      debounceMs: 60,
      onChange: (rel, count) => calls.push({ rel, count }),
      onError: (dir, error) => errors.push({ dir, error }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].dir).toBe(partialRoot);
    expect(errors[0].error.message).toContain("declared entry is missing");
    // macOS may deliver fixture-creation events after the watcher attaches.
    await delay(300);
    calls.length = 0;
    for (const ignored of [
      "dist/index.node.js",
      "dist/manifest.json",
      "models/text.d.ts",
      "models/text.test.ts",
      "node_modules/dependency.ts",
      "__tests__/fixture.ts",
    ]) {
      writeFileSync(
        path.join(pluginRoot, ignored),
        "export const ignored = 1;\n",
      );
    }
    await delay(250);
    expect(calls).toEqual([]);

    writeFileSync(modelPath, "export const model = 'after';\n");
    expect(await waitUntil(() => calls.length > 0, 4000)).toBe(true);
    expect(calls.some((call) => call.rel.endsWith("models/text.ts"))).toBe(
      true,
    );
    expect(calls.every((call) => call.count === 1)).toBe(true);
  });

  it.each([
    { runtime: "node", main: "./index.js" },
    { runtime: "bun", main: "./index.js" },
    { runtime: "node", main: "./dist/index.js" },
    { runtime: "bun", main: "./dist/index.js" },
  ])(
    "loads the published helper under $runtime/source condition with main $main",
    ({ runtime, main }) => {
      root = mkdtempSync(path.join(tmpdir(), "agent-watch-installed-"));
      const agentPackage = path.join(root, "node_modules/@elizaos/agent");
      const compiledRoot = path.join(agentPackage, path.dirname(main));
      mkdirSync(path.join(compiledRoot, "runtime"), { recursive: true });
      writeFileSync(
        path.join(agentPackage, "package.json"),
        JSON.stringify({
          name: "@elizaos/agent",
          type: "module",
          main,
          exports: {
            "./package.json": "./package.json",
            "./runtime/*": {
              "eliza-source": "./src/runtime/*.ts",
              bun: "./src/runtime/*.ts",
              default: `${path.dirname(main)}/runtime/*.js`,
            },
          },
        }),
      );
      const helperSource = readFileSync(
        path.join(
          repoRoot,
          "packages/agent/src/runtime/workspace-plugin-source.ts",
        ),
        "utf8",
      );
      writeFileSync(
        path.join(compiledRoot, "runtime/workspace-plugin-source.js"),
        stripTypeScriptTypes(helperSource),
      );
      const watcherPath = path.join(root, "watcher.mjs");
      writeFileSync(
        watcherPath,
        readFileSync(
          fileURLToPath(new URL("./agent-source-watcher.mjs", import.meta.url)),
          "utf8",
        ),
      );
      const pluginRoot = path.join(root, "plugins/plugin-flat");
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          elizaos: { plugin: { workspaceSource: { ".": "./index.node.ts" } } },
        }),
      );
      writeFileSync(
        path.join(pluginRoot, "index.node.ts"),
        "export const source = true;\n",
      );
      const child = spawnSync(
        runtime === "node" ? process.execPath : "bun",
        [
          ...(runtime === "bun" ? ["--no-install"] : ["--input-type=module"]),
          "--conditions=eliza-source",
          "-e",
          `import { collectAgentSourceDirs } from ${JSON.stringify(pathToFileURL(watcherPath).href)}; console.log(JSON.stringify(collectAgentSourceDirs(${JSON.stringify(root)})));`,
        ],
        { cwd: root, encoding: "utf8", timeout: 10_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual([pluginRoot]);
    },
  );

  it("reports a high changed-count for a bulk rewrite (so callers can skip it)", async () => {
    root = mkdtempSync(path.join(tmpdir(), "agent-watch-bulk-"));
    const srcDir = path.join(root, "plugins", "plugin-x", "src");
    mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        path.join(srcDir, `mod-${i}.ts`),
        `export const v${i}=0;\n`,
      );
    }

    const calls = [];
    handle = startAgentSourceWatcher({
      root,
      debounceMs: 300,
      onChange: (rel, count) => calls.push({ rel, count }),
    });
    expect(handle.count).toBe(1);

    await delay(200);
    // Simulate a reset/checkout: many files rewritten in one burst.
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        path.join(srcDir, `mod-${i}.ts`),
        `export const v${i}=1;\n`,
      );
      await delay(5);
    }

    const fired = await waitUntil(() => calls.length > 0, 4000);
    expect(fired).toBe(true);
    // macOS can coalesce fs.watch events, but burst rewrites still report more
    // than the default bulk threshold used by dev-ui.
    expect(Math.max(...calls.map((c) => c.count))).toBeGreaterThan(4);
  });
});
