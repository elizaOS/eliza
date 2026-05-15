import { accessSync, constants } from "node:fs";
import path from "node:path";
import { readConfigEnvKey } from "./config-env.js";
import { resolveVendoredOpencodeShim } from "./opencode-config.js";

export const ORCHESTRATOR_TOOL_NAMES = [
  "sh",
  "git",
  "rg",
  "bun",
  "acpx",
  "elizaos",
  "pi-agent",
  "codex",
  "claude",
  "opencode",
] as const;

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];

export interface OrchestratorToolCapability {
  name: OrchestratorToolName;
  path?: string;
  available: boolean;
}

export interface ResolvedOrchestratorShell {
  command: string;
  args: string[];
  available: boolean;
  source: "env:CODING_TOOLS_SHELL" | "env:SHELL" | "candidate" | "fallback";
  warning?: string;
}

export type OrchestratorUnsupportedReason =
  | "store_build"
  | "vanilla_mobile"
  | "not_local_yolo"
  | "missing_shell";

export interface OrchestratorTerminalSupport {
  supported: boolean;
  reason?: OrchestratorUnsupportedReason;
  message?: string;
}

const ANDROID_PATH_ENTRIES = ["/system/bin", "/system/xbin", "/vendor/bin"];

export function isAndroidRuntime(): boolean {
  return (
    process.env.ELIZA_PLATFORM?.trim().toLowerCase() === "android" ||
    Boolean(process.env.ANDROID_ROOT || process.env.ANDROID_DATA)
  );
}

function isIosRuntime(): boolean {
  return process.env.ELIZA_PLATFORM?.trim().toLowerCase() === "ios";
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isStoreBuild(): boolean {
  const variant = process.env.ELIZA_BUILD_VARIANT ?? "";
  return variant.trim().toLowerCase() === "store";
}

function runtimeMode(): string {
  return (
    process.env.ELIZA_RUNTIME_MODE ??
    process.env.RUNTIME_MODE ??
    process.env.LOCAL_RUNTIME_MODE ??
    ""
  )
    .trim()
    .toLowerCase();
}

export function isAospTerminalRuntime(): boolean {
  return isAndroidRuntime() && isTruthyEnv(process.env.ELIZA_AOSP_BUILD);
}

function pathEntries(): string[] {
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (isAndroidRuntime()) {
    for (const entry of ANDROID_PATH_ENTRIES) {
      if (!entries.includes(entry)) entries.push(entry);
    }
  }
  return entries;
}

function canExecute(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(nameOrPath: string): string | undefined {
  const trimmed = nameOrPath.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("/") || path.isAbsolute(trimmed)) {
    return canExecute(trimmed) ? trimmed : undefined;
  }
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, trimmed);
    if (canExecute(candidate)) return candidate;
  }
  return undefined;
}

function firstExecutable(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function configuredToolCommand(name: OrchestratorToolName): string | undefined {
  switch (name) {
    case "acpx":
      return readConfigEnvKey("ELIZA_ACP_CLI");
    case "elizaos":
      return (
        readConfigEnvKey("ELIZAOS_ACP_COMMAND") ??
        readConfigEnvKey("ELIZA_ELIZAOS_ACP_COMMAND")
      );
    case "pi-agent":
      return readConfigEnvKey("ELIZA_PI_AGENT_ACP_COMMAND");
    case "opencode":
      return readConfigEnvKey("ELIZA_OPENCODE_ACP_COMMAND");
    default:
      return undefined;
  }
}

function firstCommandWord(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    return trimmed.slice(1).split('"')[0] ?? "";
  }
  if (trimmed.startsWith("'")) {
    return trimmed.slice(1).split("'")[0] ?? "";
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

function resolveConfiguredToolCommand(
  name: OrchestratorToolName,
): string | undefined {
  const configured = configuredToolCommand(name);
  if (configured?.trim()) {
    const executable = firstCommandWord(configured);
    const resolved = executable ? resolveExecutable(executable) : undefined;
    return resolved ? configured.trim() : undefined;
  }
  if (name === "opencode") {
    const vendoredShim = resolveVendoredOpencodeShim();
    if (vendoredShim) {
      const executable =
        process.platform === "win32" ? "opencode.cmd" : "opencode";
      return path.join(vendoredShim, executable);
    }
  }
  return undefined;
}

export function resolveOrchestratorShell(): ResolvedOrchestratorShell {
  const explicitEntries = [
    ["CODING_TOOLS_SHELL", process.env.CODING_TOOLS_SHELL] as const,
    ["SHELL", process.env.SHELL] as const,
  ];
  for (const [key, raw] of explicitEntries) {
    const value = raw?.trim();
    if (!value) continue;
    const resolved = resolveExecutable(value);
    if (resolved) {
      return {
        command: resolved,
        args: ["-c"],
        available: true,
        source:
          key === "CODING_TOOLS_SHELL" ? "env:CODING_TOOLS_SHELL" : "env:SHELL",
      };
    }
  }

  const candidates = isAndroidRuntime()
    ? ["/system/bin/sh", "sh"]
    : ["/bin/bash", "bash", "/bin/sh", "sh"];
  const shell = firstExecutable(candidates);
  if (shell) {
    return {
      command: shell,
      args: ["-c"],
      available: true,
      source: "candidate",
    };
  }

  return {
    command: isAndroidRuntime() ? "/system/bin/sh" : "sh",
    args: ["-c"],
    available: false,
    source: "fallback",
    warning: isAndroidRuntime()
      ? "No executable POSIX shell was detected. Android direct/AOSP local-yolo builds must expose /system/bin/sh or set CODING_TOOLS_SHELL to an executable shell."
      : "No executable shell was detected. Set SHELL or CODING_TOOLS_SHELL to an executable shell.",
  };
}

export function detectOrchestratorCapabilities(): OrchestratorToolCapability[] {
  return ORCHESTRATOR_TOOL_NAMES.map((name) => {
    if (name === "sh") {
      const shell = resolveOrchestratorShell();
      return {
        name,
        path: shell.available ? shell.command : undefined,
        available: shell.available,
      };
    }
    const configured = resolveConfiguredToolCommand(name);
    if (configured) return { name, path: configured, available: true };
    const resolved = resolveExecutable(name);
    return { name, path: resolved, available: Boolean(resolved) };
  });
}

export function formatOrchestratorCapabilities(
  capabilities = detectOrchestratorCapabilities(),
): string {
  return capabilities
    .map((capability) =>
      capability.available
        ? `${capability.name}=ok(${capability.path})`
        : `${capability.name}=missing`,
    )
    .join(" ");
}

export function missingToolMessage(tool: OrchestratorToolName): string {
  if (tool === "sh") {
    return (
      resolveOrchestratorShell().warning ?? "No executable shell was detected."
    );
  }
  const suffix = isAndroidRuntime()
    ? " On Android direct/AOSP builds, stage the binary into the agent image and include its directory in PATH."
    : " Install it or add it to PATH.";
  return `${tool} CLI is not available in PATH.${suffix}`;
}

export function detectOrchestratorTerminalSupport(): OrchestratorTerminalSupport {
  if (isStoreBuild()) {
    return {
      supported: false,
      reason: "store_build",
      message:
        "Coding agents are unavailable in store builds because the OS sandbox blocks spawning local shells and developer CLIs.",
    };
  }

  if (isIosRuntime()) {
    return {
      supported: false,
      reason: "vanilla_mobile",
      message:
        "Coding agents are unavailable on iOS because the runtime does not expose shell, coding, or orchestrator subprocess capabilities.",
    };
  }

  if (isAndroidRuntime()) {
    if (runtimeMode() !== "local-yolo") {
      return {
        supported: false,
        reason: "not_local_yolo",
        message:
          "Android direct/AOSP coding agents require ELIZA_RUNTIME_MODE=local-yolo so subprocesses run in the local agent environment.",
      };
    }
    const shell = resolveOrchestratorShell();
    if (!shell.available) {
      return {
        supported: false,
        reason: "missing_shell",
        message:
          shell.warning ??
          "Android direct/AOSP coding agents require an executable shell. Set CODING_TOOLS_SHELL or SHELL to a staged shell binary.",
      };
    }
  }

  return { supported: true };
}
