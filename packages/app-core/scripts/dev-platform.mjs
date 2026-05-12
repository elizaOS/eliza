#!/usr/bin/env node
/**
 * dev:desktop — orchestrates Eliza desktop local development (Vite, API, Electrobun).
 *
 * ## Why orchestrate instead of "just run electrbun"?
 * Electrobun needs a renderer URL, usually the dashboard API, and (in dev) repo-root `dist/`
 * for the embedded runtime. One script keeps ports and env vars aligned and implements a
 * single shutdown policy so the terminal does not hang with stray children.
 *
 * ## Startup phases
 * 1. **Renderer production build** — Runs `vite build` only when `viteRendererBuildNeeded()`
 *    says `packages/app/dist` is missing or older than sources (cheap mtime heuristic). Override:
 *    `--force-renderer` or `ELIZA_DESKTOP_RENDERER_BUILD=always`. **Why skip:** redundant
 *    production builds on every restart are slow; watch mode users get HMR from `vite dev`.
 * 2. **Root bundle** — `tsdown` at repo root if `dist/entry.js` missing (Electrobun eliza-dist).
 * 3. **Long-lived children** (see `launch()`):
 *    - **API** — `bun --watch dev-server` unless `--no-api`.
 *    - **Watch + default** — Vite **dev** server + `ELIZA_RENDERER_URL` for Electrobun (HMR).
 *      Stale dep chunks: `--vite-force` or `ELIZA_VITE_FORCE=1` / `ELIZA_VITE_FORCE=1` (passes `vite --force`).
 *    - **Watch + Rollup** — `--rollup-watch` or `ELIZA_DESKTOP_VITE_BUILD_WATCH=1` with
 *      `ELIZA_DESKTOP_VITE_WATCH=1`: legacy `vite build --watch` (slow on large graphs).
 *    - **Electrobun** — `bun run dev` in `packages/app-core/platforms/electrobun`.
 *
 * ## Port allocation (`launch()`) — WHY
 * Before spawning API / Vite / Electrobun, `allocateFirstFreeLoopbackPort()` from
 * `eliza/packages/app-core/scripts/lib/allocate-loopback-port.mjs` resolves **ELIZA_API_PORT** (default
 * 31337) and, in Vite dev mode, **ELIZA_PORT** (default 2138) if something else
 * already listens. **Why:** every child must agree on the same numbers; Vite's
 * proxy is fixed at config load time, so "API picks a port later" desyncs the UI.
 *
 * ## Signals (Unix) — why `detached: true` on children
 * TTY Ctrl-C is sent to the **foreground process group**. Non-detached children share that
 * group, so Electrobun could consume the first SIGINT while Vite/API stayed up; the parent
 * stayed alive on open stdio pipes. **Detached** puts services in their own session so this
 * process alone receives Ctrl-C and runs one coordinated teardown (SIGTERM → brief grace →
 * SIGKILL). Second Ctrl-C force-exits if you are stuck.
 *
 * ## Quit from the app
 * When Electrobun exits (user chose Quit), siblings would otherwise keep the orchestrator
 * alive. We detect electrbun's `exit` and stop Vite/API the same way as signal shutdown.
 *
 * Docs: docs/apps/desktop-local-development.md
 *
 * ## Observability (IDEs / agents) — WHY
 *
 * This script sets env so the Eliza API and Electrobun expose **machine-readable** hooks:
 * - Aggregated child log file + `ELIZA_DESKTOP_DEV_LOG_PATH` → `GET /api/dev/console-log` (loopback tail).
 * - Screenshot token + upstream URL → `GET /api/dev/cursor-screenshot` on the API (proxies Electrobun).
 * **Why:** multiple processes (Vite, API, Electrobun) are opaque to tools that cannot see the native
 *   window; loopback + optional token bounds exposure vs. convenience. Defaults are **on** so agents
 *   and humans debugging together get signal; opt-out via `ELIZA_DESKTOP_DEV_LOG=0` and
 *   `ELIZA_DESKTOP_SCREENSHOT_SERVER=0`.
 */

import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  colorizeDevSettingsStartupBanner,
  resolveDesktopApiPort,
  resolveDesktopUiPort,
} from "@elizaos/shared";
import chalk from "chalk";
import { allocateFirstFreeLoopbackPort } from "./lib/allocate-loopback-port.mjs";
import { createApiSupervisor } from "./lib/api-supervisor.mjs";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { signalSpawnedProcessTree } from "./lib/kill-process-tree.mjs";
import { killUiListenPort } from "./lib/kill-ui-listen-port.mjs";
import { extendNodePathEnv } from "./lib/node-path-env.mjs";
import { formatOrchestratorDesktopDevBanner } from "./lib/orchestrator-desktop-dev-banner.mjs";
import { appIdentityEnv } from "./lib/read-app-identity.mjs";
import { viteRendererBuildNeeded } from "./lib/vite-renderer-dist-stale.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// `_elizaRoot` is the eliza repo root itself (3 levels up from
// scripts/). `elizaRoot` is the *wrapper* repo root (4 levels up) used
// when eliza is checked out as a subdir of a parent project. We pick
// between them by detecting which layout exists.
const _elizaRoot = path.resolve(here, "../../..");
const _wrapperRoot = path.resolve(here, "../../../..");
const isElizaMonorepo =
  existsSync(path.join(_wrapperRoot, "package.json")) &&
  existsSync(
    path.join(_wrapperRoot, "eliza", "packages", "app-core", "package.json"),
  );
// Standalone eliza checkout — _elizaRoot IS the repo and there's no
// outer wrapper. dev-platform.mjs originally only handled the wrapper
// layout; this branch keeps the standalone (and our Windows monorepo
// dev) build working.
const isStandaloneEliza =
  !isElizaMonorepo &&
  existsSync(path.join(_elizaRoot, "package.json")) &&
  existsSync(path.join(_elizaRoot, "packages", "app-core", "package.json"));
const elizaRoot = isStandaloneEliza ? _elizaRoot : _wrapperRoot;
const bundleRoot = elizaRoot;

function resolveRendererAppDir() {
  return resolveMainAppDir(bundleRoot, "app");
}

function resolveElectrobunDir() {
  if (isElizaMonorepo) {
    return path.join(
      elizaRoot,
      "eliza",
      "packages",
      "app-core",
      "platforms",
      "electrobun",
    );
  }
  return path.join(
    elizaRoot,
    "packages",
    "app-core",
    "platforms",
    "electrobun",
  );
}

const devServerEntry = isElizaMonorepo
  ? "eliza/packages/app-core/src/runtime/dev-server.ts"
  : "packages/app-core/src/runtime/dev-server.ts";

const appDir = resolveRendererAppDir();
const electrobunDir = resolveElectrobunDir();
const defaultElizaNamespace =
  isElizaMonorepo &&
  path
    .resolve(appDir)
    .startsWith(`${path.resolve(elizaRoot, "eliza")}${path.sep}`)
    ? "eliza"
    : isElizaMonorepo
      ? "eliza"
      : "eliza";

const BUN_EXECUTABLE = process.versions?.bun ? process.execPath : "bun";

// Load worktree-specific env overrides (ports, state dir) before anything reads process.env.
// Generated by: bash scripts/worktree-env.sh <slot>
const _worktreeEnvPath = path.join(bundleRoot, ".env.worktree");
if (existsSync(_worktreeEnvPath)) {
  const { config: dotenvConfig } = await import("dotenv");
  dotenvConfig({ path: _worktreeEnvPath, override: false });
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: bun run dev:desktop [options]
       ELIZA_DESKTOP_VITE_WATCH=1 bun eliza/packages/app-core/scripts/dev-platform.mjs   # same as bun run dev

Starts Vite (optional), API (optional), and Electrobun with aligned ports and env.

Options:
  --no-api           Skip the API server (Electrobun + renderer only)
  --force-renderer   Force vite build before starting (even if dist is fresh)
  --rollup-watch     Use vite build --watch instead of vite dev (requires ELIZA_DESKTOP_VITE_WATCH=1)
  --vite-force       Pass --force to Vite (clear dep optimization cache on dev server start)
  -h, --help         Show this help

At startup, four settings tables print (Unicode frame; cyan on TTY) (orchestrator, Vite, API, Electrobun):
columns Setting / Effective / Source / Change — Source shows default vs explicitly set.
Secrets are redacted. Run without --help to see them.

Environment (CI / automation; flags override where noted):
  ELIZA_DESKTOP_RENDERER_BUILD=always   Same as --force-renderer
  ELIZA_DESKTOP_VITE_BUILD_WATCH=1      Same as --rollup-watch (with ELIZA_DESKTOP_VITE_WATCH=1)
  ELIZA_VITE_FORCE=1 / ELIZA_VITE_FORCE=1   Same as --vite-force
  ELIZA_DESKTOP_SCREENSHOT_SERVER=0     Disable screenshot dev server
  ELIZA_DESKTOP_DEV_LOG=0               Disable aggregated log file
  ELIZA_DESKTOP_API_WATCH=0             Disable bun --watch for the API server
  ELIZA_DESKTOP_PREWARM=0               Disable desktop startup API prewarming
  ELIZA_DESKTOP_PREWARM_BLOCKING=1      Wait for API prewarming before Electrobun launch
  ELIZA_API_PORT / ELIZA_API_PORT / ELIZA_PORT   API port (first non-empty wins)
  ELIZA_PORT                            UI port (Vite dev)

Docs: docs/apps/desktop-local-development.md
`);
  process.exit(0);
}

const skipApi = process.argv.includes("--no-api");
const forceRendererCli = process.argv.includes("--force-renderer");
const forceRenderer =
  forceRendererCli ||
  process.env.ELIZA_DESKTOP_RENDERER_BUILD === "always" ||
  process.env.ELIZA_DESKTOP_RENDERER_BUILD === "1";
const viteWatch =
  process.env.ELIZA_DESKTOP_VITE_WATCH === "1" ||
  process.env.ELIZA_DESKTOP_VITE_WATCH === "1";
const viteDepForceCli = process.argv.includes("--vite-force");
const viteDepForce =
  viteDepForceCli ||
  process.env.ELIZA_VITE_FORCE === "1" ||
  process.env.ELIZA_VITE_FORCE === "1";
const viteRollupWatchCli = process.argv.includes("--rollup-watch");
/** Legacy: Rollup `vite build --watch` (tens of seconds per edit on large graphs). */
const viteRollupWatch =
  viteWatch &&
  (viteRollupWatchCli ||
    process.env.ELIZA_DESKTOP_VITE_BUILD_WATCH === "1" ||
    process.env.ELIZA_DESKTOP_VITE_BUILD_WATCH === "1");
/** Default when VITE_WATCH: Vite dev server + Electrobun ELIZA_RENDERER_URL (fast HMR). */
const viteDevServer = viteWatch && !viteRollupWatch;
/** On by default for `dev:desktop` / `dev:desktop:watch`; set to 0/false/no/off to disable. */
const screenshotServerOptOut = (() => {
  const v = process.env.ELIZA_DESKTOP_SCREENSHOT_SERVER?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
})();
const screenshotServerEnabled = !screenshotServerOptOut;
const preferredScreenshotPort = Number.parseInt(
  process.env.ELIZA_SCREENSHOT_SERVER_PORT || "31339",
  10,
);
const preferredBrowserWorkspacePort = Number.parseInt(
  process.env.ELIZA_BROWSER_WORKSPACE_PORT || "31340",
  10,
);
const screenshotToken = screenshotServerEnabled
  ? randomBytes(24).toString("hex")
  : "";

/** On by default for dev-platform; set ELIZA_DESKTOP_DEV_LOG=0 to disable file + API tail. */
const desktopDevLogOptOut = (() => {
  const v = process.env.ELIZA_DESKTOP_DEV_LOG?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
})();
const desktopDevLogPath = desktopDevLogOptOut
  ? null
  : path.resolve(bundleRoot, ".eliza", "desktop-dev-console.log");
const desktopCefWorkaroundEnv = (() => {
  if (process.platform !== "darwin") {
    return null;
  }

  const explicit = process.env.ELIZA_DESKTOP_FORCE_CEF?.trim();
  if (explicit) {
    return explicit;
  }

  return "1";
})();
const desktopUnsafeDevtoolsEnv = (() => {
  if (process.platform !== "darwin") {
    return null;
  }

  const explicit = process.env.ELIZA_ALLOW_UNSAFE_NATIVE_DEVTOOLS?.trim();
  if (explicit) {
    return explicit;
  }

  return "1";
})();
const desktopWhisperOptOut = (() => {
  const v = process.env.ELIZA_DESKTOP_ENSURE_WHISPER?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
})();

function ensureBunRootPackageLink(packageName) {
  const rootNodeModules = path.join(bundleRoot, "node_modules");
  const packageLink = path.join(rootNodeModules, packageName);
  if (existsSync(packageLink)) {
    return;
  }

  const bunModulesDir = path.join(rootNodeModules, ".bun");
  if (!existsSync(bunModulesDir)) {
    return;
  }

  const candidates = readdirSync(bunModulesDir)
    .filter((entry) => entry.startsWith(`${packageName}@`))
    .map((entry) =>
      path.join(bunModulesDir, entry, "node_modules", packageName),
    )
    .filter((candidate) => existsSync(path.join(candidate, "package.json")));

  const target = candidates[0];
  if (!target) {
    return;
  }

  mkdirSync(path.dirname(packageLink), { recursive: true });
  try {
    symlinkSync(path.relative(rootNodeModules, target), packageLink, "dir");
    console.log(
      `[eliza] Restored missing Bun package link: node_modules/${packageName}`,
    );
  } catch (error) {
    if (existsSync(packageLink) && lstatSync(packageLink).isSymbolicLink()) {
      return;
    }
    console.warn(
      `[eliza] Warning: failed to restore node_modules/${packageName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function desktopWhisperAssetsMissing() {
  if (process.platform === "win32") {
    return false;
  }
  const whisperCppDir = path.join(
    bundleRoot,
    "node_modules",
    "whisper-node",
    "lib",
    "whisper.cpp",
  );
  const whisperBin = path.join(whisperCppDir, "main");
  const whisperModel = path.join(whisperCppDir, "models", "ggml-base.en.bin");
  return !existsSync(whisperBin) || !existsSync(whisperModel);
}

function ensureDesktopWhisperAssets() {
  if (desktopWhisperOptOut || process.platform === "win32") {
    return;
  }
  if (!desktopWhisperAssetsMissing()) {
    return;
  }

  console.log(
    "\n[eliza] Desktop voice input needs whisper.cpp assets — building them once for Electrobun dev…\n",
  );
  try {
    execSync("bun run build:whisper", {
      cwd: electrobunDir,
      stdio: "inherit",
    });
  } catch (_error) {
    console.warn(
      "[eliza] Warning: failed to build whisper.cpp for desktop voice input. " +
        "Electrobun mic/STT may stay unavailable until this succeeds.",
    );
    console.warn(
      "[eliza] Retry manually with: (cd <renderer-app>/electrobun && bun run build:whisper)",
    );
  }
}

const rendererDistStale = viteRendererBuildNeeded(appDir, bundleRoot);
const needRendererBuild = forceRenderer || rendererDistStale;
let ranInitialViteBuild = false;

if (needRendererBuild) {
  ranInitialViteBuild = true;
  console.log("\n[eliza] Building renderer (vite build)…");
  execSync("bun run vite build", { cwd: appDir, stdio: "inherit" });
  console.log("[eliza] Renderer ready.\n");
} else {
  console.log(
    "\n[eliza] Skipping vite build — renderer dist/ is up to date.\n" +
      "  Force: --force-renderer or ELIZA_DESKTOP_RENDERER_BUILD=always\n",
  );
}

const rootDistEntry = path.join(bundleRoot, "dist", "entry.js");
if (!existsSync(rootDistEntry)) {
  console.log("\n[eliza] Building root bundle for Electrobun eliza-dist…\n");
  // In a standalone-eliza checkout the repo root has no tsdown config /
  // src/index.ts, AND tsdown's plugin chain trips over `@tsdown/css`'s
  // self-resolution under Bun on Windows ("Cannot find module
  // 'tsdown/internal'"). Skip tsdown entirely and emit a minimal entry.js
  // that re-exports the canonical app-core entry. Electrobun's bun
  // runtime can load the .ts via Bun's TS support; this stub just gives
  // the runtime path-resolver something to find.
  mkdirSync(path.join(bundleRoot, "dist"), { recursive: true });
  const entryTs = isStandaloneEliza
    ? "../packages/app-core/src/entry.ts"
    : "../eliza/packages/app-core/src/entry.ts";
  const entryStub = `// auto-generated by dev-platform.mjs — re-exports the eliza entry
// so Electrobun's runtime resolver can find dist/entry.js.
export * from ${JSON.stringify(entryTs)};
`;
  writeFileSync(rootDistEntry, entryStub);
  const distPkg = path.join(bundleRoot, "dist", "package.json");
  if (!existsSync(distPkg)) {
    mkdirSync(path.dirname(distPkg), { recursive: true });
    writeFileSync(distPkg, `${JSON.stringify({ type: "module" })}\n`);
  }
}

ensureBunRootPackageLink("jsdom");
ensureDesktopWhisperAssets();

async function allocateDistinctLoopbackPort(preferredPort, reservedPorts) {
  let candidate = preferredPort;
  while (true) {
    const allocated = await allocateFirstFreeLoopbackPort(candidate);
    if (!reservedPorts.has(allocated)) {
      return allocated;
    }
    candidate = allocated + 1;
  }
}

function waitForPort(port, { timeout = 120_000, interval = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function attempt() {
      if (Date.now() > deadline) {
        reject(
          new Error(
            `Timed out waiting for port ${port} after ${timeout / 1000}s`,
          ),
        );
        return;
      }
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, interval);
      });
    }
    attempt();
  });
}

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envFlagDisabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return (
    value === "0" || value === "false" || value === "no" || value === "off"
  );
}

async function waitForApiRoute(
  port,
  pathname,
  { timeout = 120_000, interval = 400 } = {},
) {
  const deadline = Date.now() + timeout;
  const url = `http://127.0.0.1:${port}${pathname}`;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok || response.status === 401 || response.status === 403) {
        return;
      }
    } catch {
      // Keep polling until the API starts serving HTTP.
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Timed out waiting for ${pathname} on port ${port} after ${timeout / 1000}s`,
  );
}

async function waitForApiRuntimeReady(
  port,
  { timeout = 360_000, interval = 750 } = {},
) {
  const deadline = Date.now() + timeout;
  const url = `http://127.0.0.1:${port}/api/health`;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (
          body &&
          typeof body === "object" &&
          body.runtime === "ok" &&
          body.startup?.phase === "running"
        ) {
          return;
        }
      }
    } catch {
      // Keep polling until the runtime finishes bootstrapping.
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Timed out waiting for runtime readiness on port ${port} after ${timeout / 1000}s`,
  );
}

async function warmApiRoute(port, pathname, { timeout = 30_000 } = {}) {
  const headers = { Accept: "application/json" };
  const token = process.env.ELIZA_API_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers,
    signal: AbortSignal.timeout(timeout),
  });
  await response.arrayBuffer().catch(() => {});
}

async function warmApiRoutes(port) {
  const routes = [
    { pathname: "/api/apps", timeout: 90_000 },
    { pathname: "/api/coding-agents/coordinator/status", timeout: 60_000 },
    { pathname: "/api/apps/installed", timeout: 90_000 },
    { pathname: "/api/apps/runs", timeout: 30_000 },
    { pathname: "/api/computer-use/approvals", timeout: 30_000 },
    { pathname: "/api/drop/status", timeout: 30_000 },
  ];

  if (process.env.ELIZA_DESKTOP_PREWARM_CODING_PREFLIGHT !== "0") {
    routes.push({ pathname: "/api/coding-agents/preflight", timeout: 60_000 });
  }

  const started = Date.now();
  console.log("[eliza] Prewarming desktop startup API routes...");
  for (const route of routes) {
    try {
      await warmApiRoute(port, route.pathname, { timeout: route.timeout });
    } catch (error) {
      console.warn(
        `[eliza] Warning: failed to prewarm ${route.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  console.log(
    `[eliza] Desktop startup API routes prewarmed in ${Date.now() - started}ms.`,
  );
}

const children = [];

/** First Ctrl-C starts graceful shutdown; second exits immediately (pipes keep the process alive until then). */
let shuttingDown = false;

const namesForLog = [];
if (!skipApi) namesForLog.push("api");
if (viteDevServer) namesForLog.push("vite");
if (viteRollupWatch) namesForLog.push("vite");
namesForLog.push("electrobun");
const PREFIX_PAD = Math.max(...namesForLog.map((n) => n.length));

const CHILD_COLORS = {
  vite: chalk.cyan,
  api: chalk.green,
  electrobun: chalk.magenta,
  default: chalk.white,
};

function prefixStream(name, stream) {
  const plainTag = `[${name.padEnd(PREFIX_PAD)}]`;
  const colorFn = CHILD_COLORS[name] ?? CHILD_COLORS.default;
  stream.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) {
        // Use the child color for both streams. Many tools (including Electrobun)
        // write normal startup logs to stderr; red prefixes read as errors.
        const coloredTag = colorFn(plainTag);
        process.stdout.write(`${coloredTag} ${line}\n`);
        if (desktopDevLogPath) {
          try {
            appendFileSync(desktopDevLogPath, `${plainTag} ${line}\n`, "utf8");
          } catch {
            /* ignore disk errors — console remains primary */
          }
        }
      }
    }
  });
}

function pushChild(name, cmd, args, cwd, extraEnv = {}) {
  const resolvedCmd = cmd === "bun" ? BUN_EXECUTABLE : cmd;
  const child = spawn(resolvedCmd, args, {
    cwd,
    env: extendNodePathEnv(
      { ...process.env, ...extraEnv, FORCE_COLOR: "1" },
      bundleRoot,
    ),
    stdio: ["ignore", "pipe", "pipe"],
    // Without this, macOS/Linux deliver Ctrl-C to the whole process group; Electrobun
    // then handles SIGINT ("press Ctrl+C again…") while Vite/API keep this parent alive.
    ...(process.platform !== "win32" ? { detached: true } : {}),
  });
  if (child.stdout) prefixStream(name, child.stdout);
  if (child.stderr) prefixStream(name, child.stderr);
  child.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `exit ${code}`;
    console.log(`[${name}] stopped (${reason})`);
    if (name === "electrobun" && !shuttingDown) {
      const exitCode = signal ? 1 : (code ?? 0);
      shutdownDesktopDev({
        exitCode,
        message:
          "\n[eliza] Electrobun exited — stopping Vite/API and closing dev session.",
      });
    }
  });
  children.push(child);
  return child;
}

async function launch() {
  const preferredApi = resolveDesktopApiPort(process.env);
  const resolvedApiPort = await allocateFirstFreeLoopbackPort(preferredApi);
  if (resolvedApiPort !== preferredApi) {
    console.log(
      `[eliza] API port ${preferredApi} in use — using ${resolvedApiPort} (Vite proxy + Electrobun env updated)`,
    );
  }
  const apiPort = String(resolvedApiPort);

  const preferredUi = resolveDesktopUiPort(process.env);
  let uiDevPort = preferredUi;
  if (viteDevServer) {
    uiDevPort = await allocateFirstFreeLoopbackPort(preferredUi);
    if (uiDevPort !== preferredUi) {
      console.log(
        `[eliza] UI port ${preferredUi} in use — Vite dev server using ${uiDevPort}`,
      );
    }
  }

  const rendererUrlForShell = viteDevServer
    ? `http://127.0.0.1:${uiDevPort}/`
    : "";
  const browserWorkspacePort = await allocateDistinctLoopbackPort(
    preferredBrowserWorkspacePort,
    new Set([resolvedApiPort, uiDevPort]),
  );
  if (browserWorkspacePort !== preferredBrowserWorkspacePort) {
    console.log(
      `[eliza] Browser workspace port ${preferredBrowserWorkspacePort} in use — using ${browserWorkspacePort}`,
    );
  }
  const screenshotPort = screenshotServerEnabled
    ? await allocateDistinctLoopbackPort(
        preferredScreenshotPort,
        new Set([resolvedApiPort, uiDevPort, browserWorkspacePort]),
      )
    : preferredScreenshotPort;
  if (screenshotServerEnabled && screenshotPort !== preferredScreenshotPort) {
    console.log(
      `[eliza] Screenshot port ${preferredScreenshotPort} in use — using ${screenshotPort}`,
    );
  }
  const screenshotEnvElectrobun = screenshotServerEnabled
    ? {
        ELIZA_DESKTOP_SCREENSHOT_SERVER: "1",
        ELIZA_SCREENSHOT_SERVER_PORT: String(screenshotPort),
        ELIZA_SCREENSHOT_SERVER_TOKEN: screenshotToken,
      }
    : {};
  const screenshotEnvApi = screenshotServerEnabled
    ? {
        ELIZA_ELECTROBUN_SCREENSHOT_URL: `http://127.0.0.1:${screenshotPort}`,
        ELIZA_SCREENSHOT_SERVER_TOKEN: screenshotToken,
      }
    : {};

  if (desktopDevLogPath) {
    mkdirSync(path.dirname(desktopDevLogPath), { recursive: true });
    writeFileSync(
      desktopDevLogPath,
      `--- eliza desktop dev ${new Date().toISOString()} ---\n`,
      "utf8",
    );
  }

  const serviceLine = namesForLog.join(", ");
  const orchestratorBanner = formatOrchestratorDesktopDevBanner({
    worktreePath: _worktreeEnvPath,
    worktreeLoaded: existsSync(_worktreeEnvPath),
    skipApi,
    forceRenderer,
    forceRendererCli,
    viteWatch,
    viteRollupWatch,
    viteDevServer,
    viteDepForce,
    viteDepForceCli,
    viteRollupWatchCli,
    ranInitialViteBuild,
    rendererStaleReason: rendererDistStale
      ? "dist missing or older than renderer sources"
      : null,
    preferredApiPort: preferredApi,
    allocatedApiPort: resolvedApiPort,
    preferredUiPort: preferredUi,
    allocatedUiPort: uiDevPort,
    screenshotServerEnabled,
    screenshotPort: String(screenshotPort),
    screenshotTokenRedacted: screenshotServerEnabled ? "set (redacted)" : "—",
    screenshotProxyUrl: `http://127.0.0.1:${screenshotPort}`,
    desktopDevLogPath,
    desktopDevLogOptOut,
    childrenList: serviceLine,
    elizaNamespace:
      process.env.ELIZA_NAMESPACE?.trim() || defaultElizaNamespace,
    elizaNamespaceUnset: !process.env.ELIZA_NAMESPACE?.trim(),
  });
  console.log(
    `${chalk.bold(`Eliza desktop dev${skipApi ? " (no API)" : ""}`)}\n`,
  );
  console.log(colorizeDevSettingsStartupBanner(orchestratorBanner));
  if (screenshotServerEnabled && !skipApi) {
    console.log(
      chalk.dim(
        `[eliza] Screenshot: GET http://127.0.0.1:${apiPort}/api/dev/cursor-screenshot → Electrobun :${screenshotPort}`,
      ),
    );
  }
  if (desktopDevLogPath && !skipApi) {
    console.log(
      chalk.dim(
        `[eliza] Console log tail: GET http://127.0.0.1:${apiPort}/api/dev/console-log  | file: ${desktopDevLogPath}`,
      ),
    );
  } else if (desktopDevLogPath && skipApi) {
    console.log(
      chalk.dim(
        `[eliza] Dev console log file: ${desktopDevLogPath} (no API proxy — --no-api)`,
      ),
    );
  }
  console.log("");

  const apiEnv = {
    NODE_ENV: "development",
    ELIZA_API_PORT: apiPort,
    ELIZA_HEADLESS: "1",
    ELIZA_PORT: String(uiDevPort),
    ELIZA_UI_PORT: String(uiDevPort),
    ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE ?? defaultElizaNamespace,
    ...(rendererUrlForShell ? { ELIZA_RENDERER_URL: rendererUrlForShell } : {}),
    ELIZA_DESKTOP_API_BASE: `http://127.0.0.1:${apiPort}`,
    ...screenshotEnvApi,
    ...(desktopDevLogPath
      ? { ELIZA_DESKTOP_DEV_LOG_PATH: desktopDevLogPath }
      : {}),
  };
  const apiWatchEnabled = !envFlagDisabled("ELIZA_DESKTOP_API_WATCH");
  const apiArgs = apiWatchEnabled
    ? ["--watch", devServerEntry]
    : [devServerEntry];
  if (!apiWatchEnabled) {
    console.log(
      "[eliza] API file watcher disabled (ELIZA_DESKTOP_API_WATCH=0).",
    );
  }

  const apiSupervisor = createApiSupervisor({
    spawnChild: () =>
      spawn(BUN_EXECUTABLE, apiArgs, {
        cwd: bundleRoot,
        env: extendNodePathEnv(
          { ...process.env, ...apiEnv, FORCE_COLOR: "1" },
          bundleRoot,
        ),
        stdio: ["ignore", "pipe", "pipe"],
        ...(process.platform !== "win32" ? { detached: true } : {}),
      }),
    onSpawn: (child) => {
      if (child.stdout) prefixStream("api", child.stdout);
      if (child.stderr) prefixStream("api", child.stderr);
      children.push(child);
      child.on("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `exit ${code}`;
        console.log(`[api] stopped (${reason})`);
      });
    },
    onExit: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
    },
    onGiveUp: (code) => {
      shutdownDesktopDev({
        exitCode: code ?? 1,
        message:
          "\n[eliza] API restart backoff exceeded — stopping Vite/Electrobun and closing dev session.",
      });
    },
    isShuttingDown: () => shuttingDown,
    log: (message) => console.log(`\n[eliza] ${message}`),
    warn: (message) => console.error(`\n[eliza] ${message}`),
  });

  if (!skipApi) {
    apiSupervisor.start();
    await waitForPort(Number(apiPort));
    await waitForApiRoute(Number(apiPort), "/api/status");
    if (envFlagEnabled("ELIZA_DESKTOP_WAIT_FOR_RUNTIME")) {
      console.log(
        "[eliza] Waiting for runtime readiness before opening desktop renderer…",
      );
      await waitForApiRuntimeReady(Number(apiPort));
      console.log("[eliza] Runtime ready.");
      if (envFlagEnabled("ELIZA_DESKTOP_PREWARM_BLOCKING")) {
        await warmApiRoutes(Number(apiPort));
      } else if (!envFlagDisabled("ELIZA_DESKTOP_PREWARM")) {
        void warmApiRoutes(Number(apiPort)).catch((error) => {
          console.warn(
            `[eliza] Warning: desktop startup API prewarm failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    }
  }

  if (viteDevServer) {
    killUiListenPort(uiDevPort);
    console.log(
      "\n[eliza] Vite dev server (HMR) for desktop — Electrobun loads ELIZA_RENDERER_URL.\n" +
        `    (Slow Rollup watch: ELIZA_DESKTOP_VITE_BUILD_WATCH=1 with ELIZA_DESKTOP_VITE_WATCH=1)\n`,
    );
    if (viteDepForce) {
      console.log(
        "[eliza] Vite --force (ELIZA_VITE_FORCE=1): re-optimizing dependencies.\n",
      );
    }
    pushChild(
      "vite",
      "bun",
      viteDepForce ? ["run", "vite", "--", "--force"] : ["run", "vite"],
      appDir,
      {
        NODE_ENV: "development",
        ELIZA_VITE_LOOPBACK_ORIGIN: "1",
        ELIZA_PORT: String(uiDevPort),
        ELIZA_UI_PORT: String(uiDevPort),
        ELIZA_API_PORT: apiPort,
        ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE ?? defaultElizaNamespace,
      },
    );
    await waitForPort(uiDevPort);
    console.log(`[eliza] Vite ready on ${rendererUrlForShell}\n`);
  }

  if (viteRollupWatch) {
    pushChild("vite", "bun", ["run", "vite", "build", "--watch"], appDir, {
      ELIZA_DESKTOP_VITE_FAST_DIST: "1",
    });
  }

  pushChild("electrobun", "bun", ["run", "dev"], electrobunDir, {
    NODE_ENV: "development",
    ELECTROBUN_SKIP_CODESIGN: "1",
    ...appIdentityEnv(appDir),
    ...(desktopCefWorkaroundEnv
      ? { ELIZA_DESKTOP_FORCE_CEF: desktopCefWorkaroundEnv }
      : {}),
    ...(desktopUnsafeDevtoolsEnv
      ? {
          ELIZA_ALLOW_UNSAFE_NATIVE_DEVTOOLS: desktopUnsafeDevtoolsEnv,
        }
      : {}),
    ...(rendererUrlForShell ? { ELIZA_RENDERER_URL: rendererUrlForShell } : {}),
    ...(skipApi
      ? {}
      : {
          ELIZA_API_PORT: apiPort,
          ELIZA_UI_PORT: String(uiDevPort),
          ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE ?? defaultElizaNamespace,
          ELIZA_DESKTOP_API_BASE: `http://127.0.0.1:${apiPort}`,
        }),
    ELIZA_BROWSER_WORKSPACE_PORT: String(browserWorkspacePort),
    ...screenshotEnvElectrobun,
  });
}

/**
 * SIGTERM still-running children, wait for `exit` (or force SIGKILL), then `process.exit`.
 *
 * Skips PIDs that already exited so we do not signal stale trees after app Quit.
 * `checkAllExited` + short timeout **why:** piped stdio keeps the event loop alive until
 * every child is gone; exiting early avoids staring at a hung terminal after children die.
 */
function shutdownDesktopDev({
  exitCode = 0,
  message = "\n[eliza] Shutting down desktop dev environment...",
} = {}) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(message);

  let exitScheduled = false;
  const finish = () => {
    if (exitScheduled) return;
    exitScheduled = true;
    process.exit(exitCode);
  };

  const checkAllExited = () => {
    const anyRunning = children.some(
      (c) => c.exitCode === null && c.signalCode === null,
    );
    if (!anyRunning) {
      finish();
    }
  };

  for (const child of children) {
    child.once("exit", checkAllExited);
    child.once("error", checkAllExited);
    if (child.exitCode === null && child.signalCode === null) {
      signalSpawnedProcessTree(child, "SIGTERM");
    }
  }
  checkAllExited();

  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        signalSpawnedProcessTree(child, "SIGKILL");
      }
    }
    finish();
  }, 1500).unref();
}

function cleanup() {
  if (shuttingDown) {
    console.log("\n[eliza] Force exit.");
    process.exit(1);
    return;
  }
  shutdownDesktopDev({
    exitCode: 0,
    message: "\n[eliza] Shutting down desktop dev environment...",
  });
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
if (process.platform !== "win32") {
  process.on("SIGHUP", cleanup);
}

launch().catch((err) => {
  console.error("[eliza] dev-platform failed:", err);
  for (const child of children) {
    signalSpawnedProcessTree(child, "SIGKILL");
  }
  process.exit(1);
});
