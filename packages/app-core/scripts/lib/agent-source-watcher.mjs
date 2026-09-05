/**
 * Agent source hot-reload watcher.
 *
 * Watches backend `src` dirs and declared flat plugin source, firing a debounced
 * callback for hand-written code changes. Build output, dependencies, declarations
 * and tests are excluded so a package build cannot restart the API mid-write.
 *
 * dev-ui.mjs wires `onChange` to the API supervisor's `restart()`.
 */

import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve through the agent package boundary, but use its lightweight source
// module in a checkout so this dev tool never depends on an older agent build.
// Published agent packages expose the same helper through their compiled export.
const agentManifestUrl = import.meta.resolve("@elizaos/agent/package.json");
const sourceHelperUrl = new URL(
  "./src/runtime/workspace-plugin-source.ts",
  agentManifestUrl,
);
let sourceHelperSpecifier = sourceHelperUrl.href;
if (!existsSync(fileURLToPath(sourceHelperUrl))) {
  const agentManifest = JSON.parse(
    readFileSync(fileURLToPath(agentManifestUrl), "utf8"),
  );
  if (typeof agentManifest.main !== "string") {
    throw new Error(
      "Installed @elizaos/agent is missing its compiled main entry.",
    );
  }
  // Published manifests flatten dist; anchor to their compiled main directory.
  // Re-entering exports here could select missing src under Bun/eliza-source.
  sourceHelperSpecifier = pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(agentManifestUrl)),
      path.dirname(agentManifest.main),
      "runtime/workspace-plugin-source.js",
    ),
  ).href;
}
const { resolvePackageSourceEntry } = await import(sourceHelperSpecifier);

// Pure-frontend packages are served + HMR'd by Vite and are NOT loaded by the
// API child, so editing them must not bounce the agent.
export const HOT_RELOAD_FRONTEND_PACKAGES = new Set([
  "ui",
  "app",
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
 * Collect backend source dirs, including flat plugins with valid source entries.
 * Skips pure-frontend packages (Vite owns those) and undeclared src-less packages.
 *
 * @param {string} root Repo root that holds `packages/` and `plugins/`.
 * @param {(dir: string, err: Error) => void} [onError] Invalid optional candidate.
 * @returns {string[]} Absolute source directories to watch.
 */
export function collectAgentSourceDirs(root, onError) {
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
      const packageDir = path.join(groupDir, entry.name);
      const srcDir = path.join(packageDir, "src");
      if (existsSync(srcDir)) dirs.push(srcDir);
      else if (group === "plugins") {
        try {
          if (resolvePackageSourceEntry(packageDir)) dirs.push(packageDir);
        } catch (err) {
          // error-policy:J4 Report and omit an invalid optional watch candidate;
          // the selected plugin's actual import still fails on its declaration.
          if (onError) onError(packageDir, err);
          else
            process.emitWarning(
              `Hot-reload watch skipped for ${packageDir}: ${err.message}`,
            );
        }
      }
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
 * @param {(relPath: string, changedCount: number) => void} params.onChange
 *   Debounced; receives one sample path (relative to `root`, or "source" when
 *   the filename is unknown) and the number of DISTINCT files that changed in
 *   the window — so the caller can ignore bulk rewrites (a git reset / checkout
 *   / build touches many files at once; a human edit touches one or a few).
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
  const dirs = collectAgentSourceDirs(root, onError);
  /** @type {import("node:fs").FSWatcher[]} */
  const watchers = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounce = null;
  /** Distinct changed paths accumulated in the current debounce window. */
  const pendingFiles = new Set();
  let pendingSample = null;

  const fire = (absPath) => {
    if (absPath && !isReloadableChangePath(absPath)) return;
    if (absPath) {
      pendingFiles.add(absPath);
      pendingSample = absPath;
    }
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const count = pendingFiles.size;
      const sample = pendingSample;
      pendingFiles.clear();
      pendingSample = null;
      debounce = null;
      onChange(sample ? path.relative(root, sample) : "source", count);
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
