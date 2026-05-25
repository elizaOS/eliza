import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import type { BrowserTarget } from "../browser-service.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../workspace/browser-workspace-types.js";

const pluginSrcDir = path.dirname(fileURLToPath(import.meta.url));

const STAGEHAND_COMMAND_URL_ENV = [
  "ELIZA_BROWSER_STAGEHAND_COMMAND_URL",
  "STAGEHAND_BROWSER_COMMAND_URL",
  "ELIZA_STAGEHAND_COMMAND_URL",
] as const;

const STAGEHAND_BASE_URL_ENV = [
  "ELIZA_BROWSER_STAGEHAND_URL",
  "STAGEHAND_SERVER_URL",
  "ELIZA_STAGEHAND_SERVER_URL",
] as const;

const STAGEHAND_AUTO_SETUP_ENV = "ELIZA_BROWSER_STAGEHAND_AUTO_SETUP";
const STAGEHAND_ALLOW_MOBILE_ENV = "ELIZA_BROWSER_ALLOW_STAGEHAND_ON_MOBILE";

export async function maybeCreateStagehandTarget(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserTarget | null> {
  if (isDisabled(env.ELIZA_BROWSER_STAGEHAND_ENABLED)) return null;

  const mobile = isMobileRuntime(env);
  if (mobile && !isEnabled(env[STAGEHAND_ALLOW_MOBILE_ENV])) {
    logger.debug(
      "[BrowserService] stagehand target skipped on mobile; using the app browser surface instead",
    );
    return null;
  }

  if (!isDisabled(env[STAGEHAND_AUTO_SETUP_ENV])) {
    ensureLocalStagehandServer(env);
  }

  const commandUrl = resolveStagehandCommandUrl(env);
  if (!commandUrl) {
    logger.debug(
      "[BrowserService] stagehand target skipped; set ELIZA_BROWSER_STAGEHAND_COMMAND_URL or STAGEHAND_SERVER_URL to enable it",
    );
    return null;
  }

  return {
    id: "stagehand",
    name: "Stagehand Browser",
    description:
      "Fallback Stagehand/Playwright browser backend reached through a local or remote stagehand command endpoint.",
    kind: "stagehand",
    priority: 10,
    score: ({ mobile: mobileContext }) => (mobileContext ? null : 10),
    available: async () => probeStagehand(commandUrl, env),
    execute: async (command) => executeStagehandCommand(commandUrl, command),
  };
}

function resolveStagehandCommandUrl(env: NodeJS.ProcessEnv): string | null {
  for (const key of STAGEHAND_COMMAND_URL_ENV) {
    const value = normalizeUrl(env[key]);
    if (value) return value;
  }
  for (const key of STAGEHAND_BASE_URL_ENV) {
    const value = normalizeUrl(env[key]);
    if (value) return new URL("/api/browser-command", value).toString();
  }
  return null;
}

async function probeStagehand(
  commandUrl: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const healthUrl = normalizeUrl(env.ELIZA_BROWSER_STAGEHAND_HEALTH_URL);
  if (!healthUrl) return true;
  try {
    const response = await fetch(healthUrl, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function executeStagehandCommand(
  commandUrl: string,
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult> {
  const response = await fetch(commandUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error)
        : `Stagehand command endpoint returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return normalizeStagehandResult(command, body);
}

function normalizeStagehandResult(
  command: BrowserWorkspaceCommand,
  body: unknown,
): BrowserWorkspaceCommandResult {
  if (body && typeof body === "object") {
    const record = body as {
      result?: unknown;
      mode?: unknown;
      subaction?: unknown;
      value?: unknown;
    };
    const result =
      record.result && typeof record.result === "object"
        ? (record.result as BrowserWorkspaceCommandResult)
        : (record as BrowserWorkspaceCommandResult);
    return {
      ...result,
      mode: "cloud",
      subaction: command.subaction,
    };
  }
  return {
    mode: "cloud",
    subaction: command.subaction,
    value: body,
  };
}

function ensureLocalStagehandServer(env: NodeJS.ProcessEnv): boolean {
  const stagehandDir = findStagehandDir(env);
  if (!stagehandDir) return false;

  const stagehandIndex = path.join(stagehandDir, "dist", "index.js");
  if (fs.existsSync(stagehandIndex)) return true;

  const stagehandSrc = path.join(stagehandDir, "src", "index.ts");
  if (!fs.existsSync(stagehandSrc)) return false;

  try {
    if (!fs.existsSync(path.join(stagehandDir, "node_modules"))) {
      execSync("bun install --ignore-scripts", {
        cwd: stagehandDir,
        stdio: "ignore",
        timeout: 60_000,
      });
    }
    const localTsc = path.join(stagehandDir, "node_modules", ".bin", "tsc");
    if (fs.existsSync(localTsc)) {
      execFileSync(localTsc, [], {
        cwd: stagehandDir,
        stdio: "ignore",
        timeout: 60_000,
      });
    } else {
      execFileSync("bunx", ["tsc"], {
        cwd: stagehandDir,
        stdio: "ignore",
        timeout: 60_000,
      });
    }
    logger.info("[BrowserService] stagehand-server built successfully");
    return fs.existsSync(stagehandIndex);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(
      `[BrowserService] stagehand-server auto-setup failed: ${message}`,
    );
    return false;
  }
}

function findStagehandDir(env: NodeJS.ProcessEnv): string | null {
  const configured = env.ELIZA_BROWSER_STAGEHAND_DIR?.trim();
  const candidates = [
    configured,
    ...ancestorPaths(pluginSrcDir).flatMap((root) => [
      path.join(root, "stagehand-server"),
      path.join(root, "plugins", "plugin-browser", "stagehand-server"),
      path.join(root, "eliza", "plugins", "plugin-browser", "stagehand-server"),
    ]),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const dir = path.resolve(candidate);
    if (
      fs.existsSync(path.join(dir, "dist", "index.js")) ||
      fs.existsSync(path.join(dir, "src", "index.ts"))
    ) {
      return dir;
    }
  }
  return null;
}

function ancestorPaths(start: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(start);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

function normalizeUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).toString();
  } catch {
    return null;
  }
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function isDisabled(value: string | undefined): boolean {
  return value === "0" || value?.toLowerCase() === "false";
}

function isMobileRuntime(env: NodeJS.ProcessEnv): boolean {
  const platform = (
    env.ELIZA_MOBILE_PLATFORM ??
    env.ELIZA_PLATFORM ??
    env.CAPACITOR_PLATFORM ??
    ""
  ).toLowerCase();
  return platform === "ios" || platform === "android" || platform === "mobile";
}
