/**
 * Agent source hot-reload watcher.
 *
 * Watches the backend `<pkg>/src` dirs (the TypeScript the dev API child loads via
 * the `eliza-source` condition) and fires a debounced callback when real code
 * changes. Watching each `<pkg>/src` dir directly — never `dist/`, `node_modules/`,
 * or build output — means concurrent package builds rewriting `dist/` generate
 * no events here. That decoupling is the whole point: the old `node --watch`
 * followed imports into `dist/` and reloaded mid-build, so it had to be
 * disabled; this never does.
 *
 * dev-ui.mjs wires `onChange` to the API supervisor's `restart()`.
 */

import { existsSync, readdirSync, watch } from "node:fs";
import path from "node:path";

// Pure-frontend packages are served + HMR'd by Vite and are NOT loaded by the
// API child, so editing them must not bounce the agent.
export const HOT_RELOAD_FRONTEND_PACKAGES = new Set([
  "ui",
  "app",
  "cloud-frontend",
  "os-homepage",
  "homepage",
  "docs",
  "docs-elizacloud-redirect",
  "tui",
  "robot",
  "os",
]);

// Only hand-written agent source: .ts/.tsx/.mts/.cts + .json. Compiled `.js`
// is deliberately NOT matched — this monorepo emits compiled `.js`/`.d.ts`
// shadows next to `.ts` source, and reacting to those would bounce the agent on
// every build. `.d.ts` (declaration emit) is excluded explicitly since it ends
// in `.ts`.
export const HOT_RELOAD_CODE_FILE = /\.(?:tsx?|mts|cts|json)$/;
export const HOT_RELOAD_DECLARATION = /\.d\.[cm]?ts$/;
export const HOT_RELOAD_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
export const HOT_RELOAD_IGNORED_SEGMENT =
  /(?:^|[/\\])(?:dist|node_modules|\.turbo|\.git|coverage|__tests__|\.vite|build|generated)(?:[/\\]|$)/;
export const HOT_RELOAD_DEBOUNCE_MS = 350;

/**
 * Collect the `<group>/<pkg>/src` dirs whose changes should reload the agent.
 * Skips pure-frontend packages (Vite owns those) and any package without a
 * `src/` dir.
 *
 * @param {string} root Repo root that holds `packages/` and `plugins/`.
 * @returns {string[]} Absolute `<pkg>/src` dirs to watch.
 */
export function collectAgentSourceDirs(root) {
  const dirs = [];
  for (const group of ["packages", "plugins"]) {
    const groupDir = path.join(root, group);
    let entries;
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        group === "packages" &&
        HOT_RELOAD_FRONTEND_PACKAGES.has(entry.name)
      ) {
        continue;
      }
      const srcDir = path.join(groupDir, entry.name, "src");
      if (existsSync(srcDir)) dirs.push(srcDir);
    }
  }
  return dirs;
}

/**
 * Whether a watch event for `absPath` should trigger a reload. A null/empty
 * path (some platforms omit the filename) is treated as reloadable so we never
 * miss a real change. Build output, deps, generated, and test/coverage dirs are
 * ignored, as are declaration (`.d.ts`) and test/spec files; only hand-written
 * source (ts/tsx/mts/cts/json) qualifies.
 *
 * @param {string | null | undefined} absPath
 * @returns {boolean}
 */
export function isReloadableChangePath(absPath) {
  if (!absPath) return true;
  if (HOT_RELOAD_IGNORED_SEGMENT.test(absPath)) return false;
  if (HOT_RELOAD_DECLARATION.test(absPath)) return false;
  if (HOT_RELOAD_TEST_FILE.test(absPath)) return false;
  return HOT_RELOAD_CODE_FILE.test(absPath);
}

/**
 * Start watching the agent source dirs. Returns a handle with the number of
 * dirs watched and a `close()`.
 *
 * @param {Object} params
 * @param {string} params.root Repo root.
 * @param {(relPath: string) => void} params.onChange Debounced; receives the
 *   changed path relative to `root` (or "source" when the filename is unknown).
 * @param {(dir: string, err: Error) => void} [params.onError] Per-dir watch
 *   setup failure (e.g. a platform without recursive watch).
 * @param {number} [params.debounceMs]
 * @returns {{ count: number, close: () => void }}
 */
export function startAgentSourceWatcher({
  root,
  onChange,
  onError,
  debounceMs = HOT_RELOAD_DEBOUNCE_MS,
}) {
  const dirs = collectAgentSourceDirs(root);
  /** @type {import("node:fs").FSWatcher[]} */
  const watchers = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounce = null;
  let pendingFile = null;

  const fire = (absPath) => {
    if (absPath && !isReloadableChangePath(absPath)) return;
    if (absPath) pendingFile = absPath;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const changed = pendingFile;
      pendingFile = null;
      debounce = null;
      onChange(changed ? path.relative(root, changed) : "source");
    }, debounceMs);
    debounce.unref?.();
  };

  for (const dir of dirs) {
    try {
      const fsWatcher = watch(dir, { recursive: true }, (_event, filename) => {
        fire(filename ? path.join(dir, filename.toString()) : null);
      });
      // A dir vanishing mid-build (clean step) must not crash the dev process.
      fsWatcher.on("error", () => {});
      watchers.push(fsWatcher);
    } catch (err) {
      onError?.(dir, err);
    }
  }

  return {
    count: dirs.length,
    close() {
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      for (const fsWatcher of watchers) {
        try {
          fsWatcher.close();
        } catch {
          // already closed
        }
      }
    },
  };
}
