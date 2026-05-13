/**
 * Health check functions for `eliza doctor`.
 *
 * All functions are pure / injectable — no top-level side effects — so they
 * can be unit-tested without touching the filesystem or network.
 */

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveConfigPath } from "@elizaos/agent";
import { resolveStateDir } from "@elizaos/core";
import { getCloudSecret } from "@elizaos/plugin-elizacloud";
import {
  resolveApiSecurityConfig,
  resolveServerOnlyPort,
} from "@elizaos/shared";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";
export type CheckCategory = "system" | "config" | "network" | "storage";

export interface CheckResult {
  label: string;
  status: CheckStatus;
  category: CheckCategory;
  detail?: string;
  /** Short command or instruction the user (or --fix) can run to resolve the issue. */
  fix?: string;
  /** When true, --fix will spawn this command automatically. */
  autoFixable?: boolean;
}

// ---------------------------------------------------------------------------
// Model provider API key env vars (order = display preference)
// ---------------------------------------------------------------------------

export const MODEL_KEY_VARS = [
  {
    key: "ANTHROPIC_API_KEY",
    alias: "CLAUDE_API_KEY",
    label: "Anthropic (Claude)",
  },
  { key: "OPENAI_API_KEY", label: "OpenAI" },
  {
    key: "GOOGLE_API_KEY",
    alias: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google (Gemini)",
  },
  { key: "GROQ_API_KEY", label: "Groq" },
  { key: "XAI_API_KEY", alias: "GROK_API_KEY", label: "xAI (Grok)" },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter" },
  { key: "DEEPSEEK_API_KEY", label: "DeepSeek" },
  { key: "TOGETHER_API_KEY", label: "Together AI" },
  { key: "MISTRAL_API_KEY", label: "Mistral" },
  { key: "COHERE_API_KEY", label: "Cohere" },
  { key: "PERPLEXITY_API_KEY", label: "Perplexity" },
  { key: "ZAI_API_KEY", alias: "Z_AI_API_KEY", label: "Zai" },
  { key: "MOONSHOT_API_KEY", alias: "KIMI_API_KEY", label: "Kimi / Moonshot" },
  {
    key: "AI_GATEWAY_API_KEY",
    alias: "AIGATEWAY_API_KEY",
    label: "Vercel AI Gateway",
  },
  { key: "ELIZAOS_CLOUD_API_KEY", label: "elizaOS Cloud" },
  { key: "OLLAMA_BASE_URL", label: "Ollama (local)" },
] as const;

// ---------------------------------------------------------------------------
// System checks
// ---------------------------------------------------------------------------

export function checkRuntime(): CheckResult {
  const isBun = "Bun" in globalThis;

  if (isBun) {
    const bun = (globalThis as Record<string, unknown>).Bun as {
      version: string;
    };
    const [major] = bun.version.split(".").map(Number);
    if (major < 1) {
      return {
        label: "Runtime",
        category: "system",
        status: "fail",
        detail: `Bun ${bun.version} (requires >=1.0)`,
        fix: "curl -fsSL https://bun.sh/install | bash",
      };
    }
    return {
      label: "Runtime",
      category: "system",
      status: "pass",
      detail: `Bun ${bun.version}`,
    };
  }

  const ver = process.version;
  const match = ver.match(/^v(\d+)/);
  const major = match ? Number(match[1]) : 0;
  if (major < 22) {
    return {
      label: "Runtime",
      category: "system",
      status: "fail",
      detail: `Node.js ${ver} (requires >=22)`,
      fix: "Install Node.js 22+ — https://nodejs.org",
    };
  }
  return {
    label: "Runtime",
    category: "system",
    status: "pass",
    detail: `Node.js ${ver}`,
  };
}

export function checkNodeModules(projectRoot?: string): CheckResult {
  const root =
    projectRoot ??
    path.resolve(process.env.ELIZA_PROJECT_ROOT ?? process.cwd());
  const nmDir = path.join(root, "node_modules");

  if (!existsSync(nmDir)) {
    return {
      label: "node_modules",
      category: "system",
      status: "fail",
      detail: "Not installed",
      fix: "bun install",
      autoFixable: false,
    };
  }

  return {
    label: "node_modules",
    category: "system",
    status: "pass",
    detail: nmDir,
  };
}

export function checkBuildArtifacts(projectRoot?: string): CheckResult {
  const root =
    projectRoot ??
    path.resolve(process.env.ELIZA_PROJECT_ROOT ?? process.cwd());
  const distEntry = path.join(root, "dist", "entry.js");

  if (!existsSync(distEntry)) {
    return {
      label: "Build artifacts",
      category: "system",
      status: "warn",
      detail: "dist/entry.js not found — CLI running from source",
      fix: "bun run build",
    };
  }

  return {
    label: "Build artifacts",
    category: "system",
    status: "pass",
    detail: path.join(root, "dist"),
  };
}

// ---------------------------------------------------------------------------
// Config checks
// ---------------------------------------------------------------------------

export function checkConfigFile(
  configPath?: string,
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  const resolved = configPath ?? resolveConfigPath(env);

  if (!existsSync(resolved)) {
    return {
      label: "Config file",
      category: "config",
      status: "warn",
      detail: `Not found: ${resolved}`,
      fix: "eliza setup",
      autoFixable: true,
    };
  }

  try {
    JSON.parse(readFileSync(resolved, "utf-8"));
    return {
      label: "Config file",
      category: "config",
      status: "pass",
      detail: resolved,
    };
  } catch {
    return {
      label: "Config file",
      category: "config",
      status: "fail",
      detail: `Invalid JSON: ${resolved}`,
      fix: `Edit and fix: ${resolved}`,
    };
  }
}

export function checkModelKey(
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  for (const entry of MODEL_KEY_VARS) {
    // Cloud API key may have been scrubbed from process.env into the
    // sealed secret store — check there first.
    const value =
      entry.key === "ELIZAOS_CLOUD_API_KEY"
        ? (getCloudSecret("ELIZAOS_CLOUD_API_KEY") ?? env[entry.key])
        : env[entry.key];
    if (value?.trim()) {
      return {
        label: "Model API key",
        category: "config",
        status: "pass",
        detail: `${entry.key} set (${entry.label})`,
      };
    }
    if ("alias" in entry && entry.alias && env[entry.alias]?.trim()) {
      return {
        label: "Model API key",
        category: "config",
        status: "pass",
        detail: `${entry.alias} set (${entry.label})`,
      };
    }
  }
  return {
    label: "Model API key",
    category: "config",
    status: "fail",
    detail: "No model provider API key found",
    fix: "eliza setup",
    autoFixable: true,
  };
}

// ---------------------------------------------------------------------------
// Storage checks
// ---------------------------------------------------------------------------

export function checkStateDir(
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  const dir = resolveStateDir(env as NodeJS.ProcessEnv);

  if (!existsSync(dir)) {
    return {
      label: "State directory",
      category: "storage",
      status: "warn",
      detail: `${dir} (created on first run)`,
    };
  }

  try {
    accessSync(dir, constants.W_OK);
    return {
      label: "State directory",
      category: "storage",
      status: "pass",
      detail: dir,
    };
  } catch {
    return {
      label: "State directory",
      category: "storage",
      status: "fail",
      detail: `${dir} is not writable`,
      fix: `chmod u+w "${dir}"`,
    };
  }
}

export function checkDatabase(
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const dbDir = path.join(stateDir, "workspace", ".eliza", ".elizadb");

  if (!existsSync(dbDir)) {
    return {
      label: "Database",
      category: "storage",
      status: "warn",
      detail: "Not initialized (created automatically on first start)",
    };
  }

  return {
    label: "Database",
    category: "storage",
    status: "pass",
    detail: dbDir,
  };
}

const MIN_FREE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB

export function checkDiskSpace(
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  const dir = env.ELIZA_STATE_DIR?.trim() || os.homedir();

  try {
    const stats = statfsSync(dir);
    const freeBytes = stats.bsize * stats.bavail;
    const freeGB = (freeBytes / 1024 ** 3).toFixed(1);

    if (freeBytes < MIN_FREE_BYTES) {
      return {
        label: "Disk space",
        category: "storage",
        status: "warn",
        detail: `${freeGB} GB free on state volume (recommend >=1 GB)`,
      };
    }
    return {
      label: "Disk space",
      category: "storage",
      status: "pass",
      detail: `${freeGB} GB free`,
    };
  } catch {
    return {
      label: "Disk space",
      category: "storage",
      status: "skip",
      detail: "Could not read filesystem stats",
    };
  }
}

// ---------------------------------------------------------------------------
// Config checks (continued)
// ---------------------------------------------------------------------------

/** Wildcard bind addresses — same regex as server.ts. */
const WILDCARD_BIND_RE = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/;
const LOOPBACK_BIND_RE =
  /^(localhost|127\.0\.0\.1|::1|\[::1\]|0:0:0:0:0:0:0:1)$/;

export function checkHostConfig(
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  const config = resolveApiSecurityConfig(env);
  const rawBind = config.bindHost;
  const bindHost = rawBind.replace(/:\d+$/, "").toLowerCase();
  const token = config.token ?? "";
  const allowedHosts = config.allowedHosts.join(",");

  const isWildcard = WILDCARD_BIND_RE.test(bindHost);
  const isLoopback = LOOPBACK_BIND_RE.test(bindHost);

  // Wildcard bind: API is reachable from all interfaces — token auto-generated
  // each restart if not explicitly set, which breaks persistent clients.
  if (isWildcard && !token) {
    return {
      label: "Host binding",
      category: "config",
      status: "warn",
      detail: `ELIZA_API_BIND=${rawBind} — token is auto-generated each restart`,
      fix: "Set a stable ELIZA_API_TOKEN=<secret> in your environment",
    };
  }

  // Non-loopback, non-wildcard bind without a token — ensureApiTokenForBindHost
  // will auto-generate one, but flag it so the user is aware.
  if (!isLoopback && !isWildcard && !token) {
    return {
      label: "Host binding",
      category: "config",
      status: "warn",
      detail: `ELIZA_API_BIND=${rawBind} without ELIZA_API_TOKEN — token auto-generated each restart`,
      fix: "Set a stable ELIZA_API_TOKEN=<secret>",
    };
  }

  if (allowedHosts) {
    return {
      label: "Host binding",
      category: "config",
      status: "pass",
      detail: `${rawBind} + ELIZA_ALLOWED_HOSTS=${allowedHosts}`,
    };
  }

  if (!isLoopback) {
    return {
      label: "Host binding",
      category: "config",
      status: "pass",
      detail: `${rawBind} (token protected)`,
    };
  }

  return {
    label: "Host binding",
    category: "config",
    status: "pass",
    detail: "Loopback only (default)",
  };
}

// ---------------------------------------------------------------------------
// Network checks
// ---------------------------------------------------------------------------

/** Returns the process name holding a port, or null if unknown / not Unix. */
export async function getPortOwner(port: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Get the PID(s) listening on the port
    const { stdout: pidOut } = await execFileAsync("lsof", [
      "-ti",
      `:${port}`,
      "-sTCP:LISTEN",
    ]);
    const pid = pidOut.trim().split("\n")[0];
    if (!pid) return null;

    // Get the process name for that PID
    const { stdout: nameOut } = await execFileAsync("ps", [
      "-o",
      "comm=",
      "-p",
      pid,
    ]);
    const name = nameOut.trim();
    return name ? `${name} (pid ${pid})` : null;
  } catch {
    return null;
  }
}

export async function checkPort(port: number): Promise<CheckResult> {
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });

  if (!inUse) {
    return {
      label: `Port ${port}`,
      category: "network",
      status: "pass",
      detail: "Available",
    };
  }

  const owner = await getPortOwner(port);
  return {
    label: `Port ${port}`,
    category: "network",
    status: "warn",
    detail: owner ? `In use by ${owner}` : "In use by another process",
    fix: `ELIZA_PORT=<other> eliza start (current default ${resolveServerOnlyPort(process.env)})`,
  };
}

// ---------------------------------------------------------------------------
// Eliza workspace checks
// ---------------------------------------------------------------------------

export function checkElizaWorkspace(projectRoot?: string): CheckResult {
  const root =
    projectRoot ??
    path.resolve(process.env.ELIZA_PROJECT_ROOT ?? process.cwd());
  const elizaRoot = path.join(root, "eliza");
  const pluginsRoot = path.join(elizaRoot, "plugins");
  const hasElizaRoot = existsSync(path.join(elizaRoot, "package.json"));
  const hasPluginsRoot = existsSync(pluginsRoot);

  if (!hasElizaRoot && !hasPluginsRoot) {
    return {
      label: "Local upstreams",
      category: "system",
      status: "warn",
      detail:
        "Vendored source workspace not found at ./eliza (needed only for repo-local @elizaos development)",
      fix: "bun run setup:upstreams",
    };
  }

  if (existsSync(elizaRoot) && !hasElizaRoot) {
    return {
      label: "Local upstreams",
      category: "system",
      status: "warn",
      detail: `${elizaRoot} exists but missing package.json`,
      fix: "bun run setup:upstreams",
    };
  }

  const coreLink = path.join(root, "node_modules", "@elizaos", "core");
  try {
    const realTarget = realpathSync(coreLink);
    if (realTarget.startsWith(elizaRoot)) {
      return {
        label: "Local upstreams",
        category: "system",
        status: "pass",
        detail:
          "Vendored @elizaos/core workspace is active (includes the orchestrator runtime)",
      };
    }
  } catch {
    // Not a symlink or can't resolve — that's fine
  }

  const foundLocations = [
    hasElizaRoot ? "./eliza" : null,
    hasPluginsRoot ? "./eliza/plugins" : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" and ");

  return {
    label: "Local upstreams",
    category: "system",
    status: "pass",
    detail: `Found vendored sources at ${foundLocations} (run setup:upstreams to refresh workspace links)`,
  };
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  configPath?: string;
  projectRoot?: string;
  checkPorts?: boolean;
  apiPort?: number;
  uiPort?: number;
}

export async function runAllChecks(
  opts: DoctorOptions = {},
): Promise<CheckResult[]> {
  const env = opts.env ?? process.env;

  const sync: CheckResult[] = [
    // system
    checkRuntime(),
    checkNodeModules(opts.projectRoot),
    checkBuildArtifacts(opts.projectRoot),
    checkElizaWorkspace(opts.projectRoot),
    // config
    checkConfigFile(opts.configPath, env),
    checkModelKey(env),
    checkHostConfig(env),
    // storage
    checkStateDir(env),
    checkDatabase(env),
    checkDiskSpace(env),
  ];

  if (opts.checkPorts === false) {
    return sync;
  }

  const portResults = await Promise.all([
    checkPort(opts.apiPort ?? 31337),
    checkPort(opts.uiPort ?? 2138),
  ]);

  return [...sync, ...portResults];
}
