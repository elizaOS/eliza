import { accessSync, constants } from "node:fs";
import path from "node:path";

export const CODING_TOOL_NAMES = [
  "sh",
  "git",
  "rg",
  "bun",
  "acpx",
  "codex",
  "claude",
  "opencode",
] as const;

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

export interface CodingToolCapability {
  name: CodingToolName;
  path?: string;
  available: boolean;
}

export interface ResolvedShell {
  command: string;
  args: string[];
  available: boolean;
  source: "env:CODING_TOOLS_SHELL" | "env:SHELL" | "candidate" | "fallback";
  warning?: string;
}

export type TerminalUnsupportedReason =
  | "store_build"
  | "vanilla_mobile"
  | "not_local_yolo"
  | "missing_shell";

export interface TerminalSupport {
  supported: boolean;
  reason?: TerminalUnsupportedReason;
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

function isMobileRuntime(): boolean {
  return isAndroidRuntime() || isIosRuntime();
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isStoreBuild(): boolean {
<<<<<<< HEAD
  const variant =
    process.env.ELIZA_BUILD_VARIANT ?? process.env.MILADY_BUILD_VARIANT ?? "";
=======
  const variant = process.env.ELIZA_BUILD_VARIANT ?? "";
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
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

export function resolveHostShell(): ResolvedShell {
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

  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command"],
      available: true,
      source: "candidate",
    };
  }

  const candidates = isAndroidRuntime()
    ? ["/system/bin/sh", "sh", "/bin/sh"]
    : ["/bin/bash", "bash", "/bin/sh", "sh"];
  const resolved = firstExecutable(candidates);
  if (resolved) {
    return {
      command: resolved,
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
      ? "No executable POSIX shell was detected. AOSP builds must expose /system/bin/sh or set CODING_TOOLS_SHELL to an executable shell."
      : "No executable shell was detected. Set SHELL or CODING_TOOLS_SHELL to an executable shell.",
  };
}

export function detectCodingToolCapabilities(): CodingToolCapability[] {
  return CODING_TOOL_NAMES.map((name) => {
    if (name === "sh") {
      const shell = resolveHostShell();
      return {
        name,
        path: shell.available ? shell.command : undefined,
        available: shell.available,
      };
    }
    const resolved = resolveExecutable(name);
    return { name, path: resolved, available: Boolean(resolved) };
  });
}

export function formatCodingToolCapabilities(
  capabilities = detectCodingToolCapabilities(),
): string {
  return capabilities
    .map((capability) =>
      capability.available
        ? `${capability.name}=ok(${capability.path})`
        : `${capability.name}=missing`,
    )
    .join(" ");
}

export function missingToolMessage(tool: CodingToolName): string {
  if (tool === "sh") {
    return resolveHostShell().warning ?? "No executable shell was detected.";
  }
  const suffix = isAndroidRuntime()
    ? " On AOSP, ensure the binary is staged into the agent image and PATH includes /system/bin or the tool's install directory."
    : " Install it or add it to PATH.";
  return `${tool} CLI is not available in PATH.${suffix}`;
}

export function missingToolForCommand(
  command: string,
): CodingToolName | undefined {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }
  const first = tokens[index]?.replace(/^["']|["']$/g, "");
  if (!first) return undefined;
  const name = path.basename(first) as CodingToolName;
  if (
    !(CODING_TOOL_NAMES as readonly string[]).includes(name) ||
    name === "sh"
  ) {
    return undefined;
  }
  return resolveExecutable(first) ? undefined : name;
}

export function detectTerminalSupport(): TerminalSupport {
  if (isStoreBuild()) {
    return {
      supported: false,
      reason: "store_build",
      message:
        "Local coding tools are unavailable in store builds because the OS sandbox blocks spawning local shells and developer CLIs.",
    };
  }

  if (isMobileRuntime()) {
    if (!isAospTerminalRuntime()) {
      return {
        supported: false,
        reason: "vanilla_mobile",
        message:
          "Local coding tools are only available on branded AOSP builds. Vanilla mobile and store builds do not expose shell, coding, or orchestrator subprocess capabilities.",
      };
    }
    if (runtimeMode() !== "local-yolo") {
      return {
        supported: false,
        reason: "not_local_yolo",
        message:
          "AOSP coding tools require ELIZA_RUNTIME_MODE=local-yolo so commands run in the local agent environment.",
      };
    }
    const shell = resolveHostShell();
    if (!shell.available) {
      return {
        supported: false,
        reason: "missing_shell",
        message:
          shell.warning ??
          "AOSP coding tools require an executable shell. Set CODING_TOOLS_SHELL or SHELL to a staged shell binary.",
      };
    }
  }

  return { supported: true };
}
