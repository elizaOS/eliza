import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectAgentSourceDirs,
  isReloadableChangePath,
  startAgentSourceWatcher,
} from "./agent-source-watcher.mjs";

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
    if (root) rmSync(root, { recursive: true, force: true });
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
    if (root) rmSync(root, { recursive: true, force: true });
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
      onChange: (rel) => calls.push(rel),
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
    expect(calls.some((c) => c.includes("views.ts"))).toBe(true);
  });
});
