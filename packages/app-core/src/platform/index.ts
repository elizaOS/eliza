/**
 * Platform utilities — LIFO popout, LIFO runtime, onboarding permissions,
 * and platform initialization helpers.
 *
 * Migrated from apps/app/src/lifo-popout.ts, lifo-runtime.ts,
 * onboarding-permissions.ts, and main.tsx.
 */

import type {
  AllPermissionsState,
  PermissionStatus,
  SystemPermissionId,
} from "../api/client";

// ── LIFO popout ─────────────────────────────────────────────────────────

const LIFO_POPOUT_VALUES = new Set(["", "1", "true", "lifo"]);
export const LIFO_POPOUT_WINDOW_NAME = "milady-lifo-popout";
export const LIFO_POPOUT_FEATURES = "popup,width=1400,height=860";
export const LIFO_SYNC_CHANNEL_PREFIX = "milady-lifo-sync";

function popoutQueryFromHash(hash: string): string | null {
  if (!hash) return null;
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = normalized.indexOf("?");
  if (queryIndex < 0) return null;
  return new URLSearchParams(normalized.slice(queryIndex + 1)).get("popout");
}

export function isLifoPopoutValue(value: string | null): boolean {
  if (value === null) return false;
  return LIFO_POPOUT_VALUES.has(value.trim().toLowerCase());
}

export function getPopoutValueFromLocation(location: {
  search: string;
  hash: string;
}): string | null {
  const queryValue = new URLSearchParams(location.search || "").get("popout");
  if (queryValue !== null) return queryValue;
  return popoutQueryFromHash(location.hash || "");
}

export function isLifoPopoutModeAtLocation(location: {
  search: string;
  hash: string;
}): boolean {
  return isLifoPopoutValue(getPopoutValueFromLocation(location));
}

export function isLifoPopoutMode(): boolean {
  if (typeof window === "undefined") return false;
  return isLifoPopoutModeAtLocation(window.location);
}

export function generateLifoSessionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getLifoSessionIdFromLocation(location: {
  search: string;
  hash: string;
}): string | null {
  const fromSearch = new URLSearchParams(location.search || "").get(
    "lifoSession",
  );
  if (fromSearch) return fromSearch;
  const hash = location.hash || "";
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = normalized.indexOf("?");
  if (queryIndex < 0) return null;
  return new URLSearchParams(normalized.slice(queryIndex + 1)).get(
    "lifoSession",
  );
}

export function getLifoSyncChannelName(sessionId: string | null): string {
  if (sessionId) return `${LIFO_SYNC_CHANNEL_PREFIX}-${sessionId}`;
  return LIFO_SYNC_CHANNEL_PREFIX;
}

export function isSafeEndpointUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildLifoPopoutUrl(options?: {
  baseUrl?: string;
  targetPath?: string;
  sessionId?: string;
}): string {
  if (typeof window === "undefined") return "";

  const targetPath = options?.targetPath ?? "/lifo";
  const baseUrl = options?.baseUrl;
  const sessionId = options?.sessionId;

  if (window.location.protocol === "file:") {
    const sessionParam = sessionId ? `&lifoSession=${sessionId}` : "";
    return `${window.location.origin}${window.location.pathname}#${targetPath}?popout=lifo${sessionParam}`;
  }

  const url = new URL(baseUrl || window.location.href);
  url.pathname = targetPath;
  const params = new URLSearchParams(url.search);
  params.set("popout", "lifo");
  if (sessionId) params.set("lifoSession", sessionId);
  url.search = params.toString();
  url.hash = "";
  return url.toString();
}

// ── LIFO runtime ────────────────────────────────────────────────────────

export type LifoKernel = import("@lifo-sh/core").Kernel;
export type LifoShell = import("@lifo-sh/core").Shell;
export type LifoTerminal = import("@lifo-sh/ui").Terminal;
export type LifoFileExplorer = import("@lifo-sh/ui").FileExplorer;
export type LifoRegistry = import("@lifo-sh/core").CommandRegistry;
export type LifoCommandContext = import("@lifo-sh/core").CommandContext;

export interface LifoRuntime {
  kernel: LifoKernel;
  shell: LifoShell;
  terminal: LifoTerminal;
  explorer: LifoFileExplorer;
  registry: LifoRegistry;
  env: Record<string, string>;
}

export interface LifoSyncMessage {
  source: "controller";
  type:
    | "heartbeat"
    | "session-reset"
    | "command-start"
    | "stdout"
    | "stderr"
    | "command-exit"
    | "command-error";
  command?: string;
  chunk?: string;
  exitCode?: number;
  message?: string;
}

export function normalizeTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

export async function createLifoRuntime(
  terminalElement: HTMLElement,
  explorerElement: HTMLElement,
): Promise<LifoRuntime> {
  const core = await import("@lifo-sh/core");
  const ui = await import("@lifo-sh/ui");

  const kernel = new core.Kernel();
  await kernel.boot({ persist: true });

  const registry = core.createDefaultRegistry();
  core.bootLifoPackages(kernel.vfs, registry);

  const terminal = new ui.Terminal(terminalElement);
  const env = kernel.getDefaultEnv();
  const shell = new core.Shell(terminal, kernel.vfs, registry, env);

  const jobTable = shell.getJobTable();
  registry.register("ps", core.createPsCommand(jobTable));
  registry.register("top", core.createTopCommand(jobTable));
  registry.register("kill", core.createKillCommand(jobTable));
  registry.register("watch", core.createWatchCommand(registry));
  registry.register("help", core.createHelpCommand(registry));
  registry.register("node", core.createNodeCommand(kernel.portRegistry));
  registry.register("curl", core.createCurlCommand(kernel.portRegistry));

  const shellExecute = async (
    cmd: string,
    ctx: LifoCommandContext,
  ): Promise<number> => {
    const result = await shell.execute(cmd, {
      cwd: ctx.cwd,
      env: ctx.env,
      onStdout: (chunk: string) => ctx.stdout.write(chunk),
      onStderr: (chunk: string) => ctx.stderr.write(chunk),
    });
    return result.exitCode;
  };

  registry.register("npm", core.createNpmCommand(registry, shellExecute));
  registry.register("lifo", core.createLifoPkgCommand(registry, shellExecute));

  await shell.sourceFile("/etc/profile");
  await shell.sourceFile(`${env.HOME}/.bashrc`);
  shell.start();

  const explorer = new ui.FileExplorer(explorerElement, kernel.vfs, {
    cwd: shell.getCwd(),
  });

  return {
    kernel,
    shell,
    terminal,
    explorer,
    registry,
    env,
  };
}

// ── Onboarding permissions ──────────────────────────────────────────────

export const REQUIRED_ONBOARDING_PERMISSION_IDS: ReadonlyArray<SystemPermissionId> =
  ["accessibility", "screen-recording", "microphone"];

export function isOnboardingPermissionGranted(
  status: PermissionStatus | undefined,
): boolean {
  return status === "granted" || status === "not-applicable";
}

export function getMissingOnboardingPermissions(
  permissions: AllPermissionsState | null | undefined,
): SystemPermissionId[] {
  if (!permissions) return [...REQUIRED_ONBOARDING_PERMISSION_IDS];
  return REQUIRED_ONBOARDING_PERMISSION_IDS.filter((id) => {
    return !isOnboardingPermissionGranted(permissions[id]?.status);
  });
}

export function hasRequiredOnboardingPermissions(
  permissions: AllPermissionsState | null | undefined,
): boolean {
  return getMissingOnboardingPermissions(permissions).length === 0;
}

// ── Platform init ───────────────────────────────────────────────────────

export { applyLaunchConnectionFromUrl } from "./browser-launch";
export {
  type DeepLinkHandlers,
  dispatchShareTarget,
  handleDeepLink,
  injectPopoutApiBase,
  isAndroid,
  isElectronPlatform,
  isIOS,
  isNative,
  isPopoutWindow,
  isWebPlatform,
  platform,
  type ShareTargetFile,
  type ShareTargetPayload,
  setupPlatformStyles,
} from "./init";
