#!/usr/bin/env node
/**
 * Post-install script to initialize git submodules if they haven't been.
 * This ensures tracked submodules from .gitmodules are initialized when
 * cloning the repo or installing dependencies.
 *
 * Run automatically via the `postinstall` hook, or manually:
 *   node scripts/init-submodules.mjs
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const __dirname = dirname(scriptFile);
const root = resolve(__dirname, "..");
const skipLocalUpstreams =
  process.env.ELIZA_SKIP_LOCAL_UPSTREAMS === "1" ||
  process.env.ELIZA_SKIP_LOCAL_UPSTREAMS === "1";
const SUBMODULE_READINESS_MARKERS = {
  eliza: ["package.json", "packages/core/package.json"],
};

// plugin-openrouter contains PGlite :memory:<UUID> paths committed under
// typescript/ that Windows git rejects as invalid filenames. Skip checkout
// until elizaos-plugins/plugin-openrouter#25 is merged; the package is
// available via npm in the meantime.
const SKIP_SUBMODULES = new Set(["eliza/plugins/plugin-openrouter"]);

// Submodules whose own nested submodules should NOT be recursively initialized.
const NO_RECURSE_SUBMODULES = new Set([]);

/** Top-level paths that moved under `eliza/`; drop stale gitlinks after migration. */
const LEGACY_ROOT_SUBMODULE_PATHS = ["cloud", "steward-fi"];

function getSubmoduleSkipReason(
  submodulePath,
  { skipLocal = skipLocalUpstreams } = {},
) {
  if (SKIP_SUBMODULES.has(submodulePath)) {
    return "it is in the explicit skip list";
  }
  if (skipLocal && submodulePath === "eliza") {
    return "local upstreams are disabled";
  }
  return null;
}

export function shouldSkipSubmoduleInit(
  submodulePath,
  { skipLocal = skipLocalUpstreams } = {},
) {
  return getSubmoduleSkipReason(submodulePath, { skipLocal }) !== null;
}

export function parseTrackedSubmodules(configOutput) {
  if (!configOutput.trim()) return [];

  return configOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawKey, path] = line.split(/\s+/, 2);
      const name = rawKey.replace(/^submodule\./, "").replace(/\.path$/, "");
      return { name, path };
    });
}

export function loadTrackedSubmodules({ exec = execSync, cwd = root } = {}) {
  try {
    const output = exec(
      'git config --file .gitmodules --get-regexp "^submodule\\..*\\.path$"',
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return parseTrackedSubmodules(output);
  } catch {
    return [];
  }
}

/**
 * After moving `cloud` and `steward-fi` under `eliza/`, older clones may still
 * have gitlinks at the repo root. If `.gitmodules` no longer lists those paths
 * but the index still does, remove them so postinstall does not clone into
 * `./cloud` or `./steward-fi`.
 */
export function pruneLegacyRootSubmodulesMovedUnderEliza(
  rootDir,
  { exec = execSync, log = console.log, logError = console.error } = {},
) {
  const tracked = new Set(
    loadTrackedSubmodules({ exec, cwd: rootDir }).map((s) => s.path),
  );

  for (const rel of LEGACY_ROOT_SUBMODULE_PATHS) {
    if (tracked.has(rel)) {
      continue;
    }

    let mode = "";
    try {
      const line = exec(`git ls-files -s -- "${rel}"`, {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!line) {
        continue;
      }
      mode = line.split(/\s+/)[0] ?? "";
    } catch {
      continue;
    }

    if (mode !== "160000") {
      continue;
    }

    log(
      `[init-submodules] Removing stale top-level submodule "${rel}" (now under eliza/). Deinitializing…`,
    );
    try {
      exec(`git submodule deinit -f -- "${rel}"`, {
        cwd: rootDir,
        stdio: "inherit",
      });
    } catch {
      // Best effort — worktree may already be missing.
    }
    try {
      exec(`git rm -f -- "${rel}"`, {
        cwd: rootDir,
        stdio: "inherit",
      });
    } catch (err) {
      logError(
        `[init-submodules] Could not drop stale submodule "${rel}" from the index: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export function getSubmoduleReadinessMarkerPaths(
  submodulePath,
  { rootDir = root } = {},
) {
  const markers = SUBMODULE_READINESS_MARKERS[submodulePath] ?? [];
  return markers.map((marker) => resolve(rootDir, submodulePath, marker));
}

export function isSubmoduleCheckoutReady(
  submodulePath,
  { rootDir = root, exists = existsSync } = {},
) {
  const markerPaths = getSubmoduleReadinessMarkerPaths(submodulePath, {
    rootDir,
  });

  if (markerPaths.length === 0) {
    return true;
  }

  return markerPaths.every((markerPath) => exists(markerPath));
}

export function isTrackedAsGitlink(
  submodulePath,
  { exec = execSync, cwd = root } = {},
) {
  try {
    const output = exec(`git ls-files -s -- "${submodulePath}"`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) {
      return false;
    }

    const lines = output.split("\n").filter(Boolean);
    if (lines.length !== 1) {
      return false;
    }

    const [mode, , , trackedPath] = lines[0].split(/\s+/, 4);
    return mode === "160000" && trackedPath === submodulePath;
  } catch {
    return false;
  }
}

export function runInitSubmodules({
  rootDir = root,
  exists = existsSync,
  exec = execSync,
  log = console.log,
  logError = console.error,
  shouldSkipSubmodule = shouldSkipSubmoduleInit,
} = {}) {
  // Check if we're in a git repository
  const gitDir = resolve(rootDir, ".git");
  if (!exists(gitDir)) {
    log("[init-submodules] Not a git repository — skipping");
    return { initialized: 0, alreadyInitialized: 0, failed: 0, submodules: [] };
  }

  const gitmodulesPath = resolve(rootDir, ".gitmodules");
  if (!exists(gitmodulesPath)) {
    log("[init-submodules] No .gitmodules found — skipping");
    return { initialized: 0, alreadyInitialized: 0, failed: 0, submodules: [] };
  }

  const submodules = loadTrackedSubmodules({ exec, cwd: rootDir });
  if (submodules.length === 0) {
    log("[init-submodules] No tracked submodules found — skipping");
    return { initialized: 0, alreadyInitialized: 0, failed: 0, submodules: [] };
  }

  const hasLegacyRootCloudPaths = submodules.some(
    (s) => s.path === "cloud" || s.path === "steward-fi",
  );
  if (hasLegacyRootCloudPaths) {
    log(
      "[init-submodules] This .gitmodules still lists cloud/ or steward-fi/ at the repo root. Pull the latest branch where those repos are nested under eliza/, or edit .gitmodules to match.",
    );
  }

  pruneLegacyRootSubmodulesMovedUnderEliza(rootDir, {
    exec,
    log,
    logError,
    exists,
  });

  let initialized = 0;
  let alreadyInitialized = 0;
  let failed = 0;

  for (const submodule of submodules) {
    const skipReason = getSubmoduleSkipReason(submodule.path);
    if (shouldSkipSubmodule(submodule.path)) {
      log(
        `[init-submodules] Skipping ${submodule.name} (${submodule.path}) because ${skipReason ?? "local upstreams are disabled"}`,
      );
      continue;
    }

    if (!isTrackedAsGitlink(submodule.path, { exec, cwd: rootDir })) {
      log(
        `[init-submodules] Skipping ${submodule.name} (${submodule.path}) because the parent repo tracks that path as regular files, not a gitlink`,
      );
      continue;
    }

    const checkoutReady = isSubmoduleCheckoutReady(submodule.path, {
      rootDir,
      exists,
    });
    let needsInit = !checkoutReady;
    let initReason = checkoutReady ? "" : "checkout is incomplete";

    try {
      const status = exec(`git submodule status -- "${submodule.path}"`, {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (status.startsWith("-")) {
        needsInit = true;
        initReason = "submodule is not initialized";
      } else if (status.startsWith("+")) {
        // Submodule HEAD differs from the commit recorded in the parent
        // index — local commits or a branch checkout exist.
        log(
          `[init-submodules] ⚠ ${submodule.name} (${submodule.path}) has commits not recorded in the parent repo`,
        );
      }
      // Warn about uncommitted changes in initialized submodules.
      if (!status.startsWith("-")) {
        try {
          const smRoot = resolve(rootDir, submodule.path);
          const dirty = exec("git status --porcelain", {
            cwd: smRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          if (dirty) {
            log(
              `[init-submodules] ⚠ ${submodule.name} (${submodule.path}) has uncommitted local changes`,
            );
          }
        } catch {
          // Cannot check — not critical, just skip the warning.
        }
      }
    } catch {
      // If status lookup fails, attempt initialization directly.
      needsInit = true;
      if (!initReason) {
        initReason = "status check failed";
      }
    }

    if (!needsInit) {
      alreadyInitialized++;
      continue;
    }

    log(
      `[init-submodules] Initializing ${submodule.name} (${submodule.path})${
        initReason ? ` because ${initReason}` : ""
      }...`,
    );
    try {
      const recurseFlag = NO_RECURSE_SUBMODULES.has(submodule.path)
        ? ""
        : " --recursive";
      try {
        exec(`git submodule update --init${recurseFlag} "${submodule.path}"`, {
          cwd: rootDir,
          stdio: "inherit",
        });
      } catch (_shallowErr) {
        // Shallow clones (common in CI) may fail to fetch the pinned SHA.
        // Retry: register the submodule, fetch all refs deeply, then update.
        log(
          `[init-submodules] Shallow init failed for ${submodule.name}, retrying with full fetch...`,
        );
        try {
          exec(`git submodule init "${submodule.path}"`, {
            cwd: rootDir,
            stdio: "inherit",
          });
        } catch {
          // init may already have been done by the first attempt
        }
        const smRoot = resolve(rootDir, submodule.path);
        if (exists(smRoot) && exists(resolve(smRoot, ".git"))) {
          exec("git fetch --unshallow || git fetch --all", {
            cwd: smRoot,
            stdio: "inherit",
            shell: true,
          });
        }
        exec(`git submodule update${recurseFlag} "${submodule.path}"`, {
          cwd: rootDir,
          stdio: "inherit",
        });
      }
      if (
        !isSubmoduleCheckoutReady(submodule.path, {
          rootDir,
          exists,
        })
      ) {
        throw new Error(
          `submodule checkout is still incomplete after update: ${submodule.path}`,
        );
      }
      initialized++;
      log(`[init-submodules] ${submodule.name} initialized successfully`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      logError(
        `[init-submodules] Failed to initialize ${submodule.name} (${submodule.path}): ${message}`,
      );
    }
  }

  if (
    !shouldSkipSubmodule("eliza") &&
    exists(resolve(rootDir, "eliza", ".gitmodules"))
  ) {
    log(
      "[init-submodules] Ensuring nested checkouts under eliza/ (cloud, steward-fi, plugins, …)…",
    );
    try {
      // Run from inside eliza/ so git reads eliza/.gitmodules directly.
      // Running `git submodule update --init --recursive -- eliza` from the
      // parent can fail when git tries to resolve nested submodule paths
      // (e.g. eliza/cloud) against the parent's .gitmodules instead of
      // eliza's own .gitmodules.
      exec(`git submodule update --init --recursive`, {
        cwd: resolve(rootDir, "eliza"),
        stdio: "inherit",
      });
    } catch (err) {
      logError(
        `[init-submodules] Nested eliza submodule update failed (fix broken plugin submodules under eliza/ if needed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (failed > 0) {
    logError(
      `[init-submodules] Initialized ${initialized}, already ready ${alreadyInitialized}, failed ${failed}.`,
    );
  } else if (initialized === 0) {
    log("[init-submodules] All submodules already initialized");
  } else {
    log(
      `[init-submodules] Initialized ${initialized} submodule(s); ${alreadyInitialized} already ready.`,
    );
  }

  return { initialized, alreadyInitialized, failed, submodules };
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(scriptFile);

if (isDirectRun) {
  runInitSubmodules();
}
