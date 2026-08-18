/**
 * Terminal-capability detection: enumerates known terminal tool names, detects
 * whether a usable terminal/shell exists in the environment, resolves the shell
 * and executables to run, and reports the missing tool for a given command.
 */
import path from "node:path";

import { readAliasedEnv } from "@elizaos/shared";
import { resolveHostExecutable } from "@elizaos/shared/host-execution-env";

export const TERMINAL_TOOL_NAMES = [
  "sh",
  "git",
  "rg",
  "bun",
  "acpx",
  "codex",
  "claude",
] as const;

export type TerminalToolName = (typeof TERMINAL_TOOL_NAMES)[number];

export interface ToolCapability {
  name: TerminalToolName;
  path?: string;
  available: boolean;
}

export interface ShellResolution {
  shell: string;
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

export function isAndroidRuntime(): boolean {
  return (
    readAliasedEnv("ELIZA_PLATFORM")?.trim().toLowerCase() === "android" ||
    Boolean(process.env.ANDROID_ROOT || process.env.ANDROID_DATA)
  );
}

function isIosRuntime(): boolean {
  return readAliasedEnv("ELIZA_PLATFORM")?.trim().toLowerCase() === "ios";
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

export function resolveExecutable(nameOrPath: string): string | undefined {
  const trimmed = nameOrPath.trim();
  if (!trimmed) return undefined;
  return resolveHostExecutable(trimmed);
}

function firstExecutable(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

export function resolveTerminalShell(): ShellResolution {
  const candidates = isAndroidRuntime()
    ? ["/system/bin/sh", "sh"]
    : ["/bin/bash", "bash", "/bin/sh", "sh"];
  const shell = firstExecutable(candidates);
  if (shell) {
    return {
      shell,
      args: ["-c"],
      available: true,
      source: "candidate",
    };
  }

  return {
    shell: isAndroidRuntime() ? "/system/bin/sh" : "sh",
    args: ["-c"],
    available: false,
    source: "fallback",
    warning: isAndroidRuntime()
      ? "No boot-authorized POSIX shell was detected. Android direct/AOSP local-yolo builds must include /system/bin or another shell directory in the boot PATH."
      : "No boot-authorized POSIX shell was detected. Ensure the boot PATH contains an executable shell.",
  };
}

export function detectTerminalCapabilities(): ToolCapability[] {
  return TERMINAL_TOOL_NAMES.map((name) => {
    if (name === "sh") {
      const shell = resolveTerminalShell();
      return {
        name,
        path: shell.available ? shell.shell : undefined,
        available: shell.available,
      };
    }
    const resolved = resolveExecutable(name);
    return {
      name,
      path: resolved,
      available: Boolean(resolved),
    };
  });
}

export function formatTerminalCapabilities(
  capabilities = detectTerminalCapabilities(),
): string {
  return capabilities
    .map((capability) =>
      capability.available
        ? `${capability.name}=ok(${capability.path})`
        : `${capability.name}=missing`,
    )
    .join(" ");
}

export function missingToolMessage(tool: TerminalToolName): string {
  if (tool === "sh") {
    return (
      resolveTerminalShell().warning ?? "No executable shell was detected."
    );
  }
  const suffix = isAndroidRuntime()
    ? " On Android direct/AOSP builds, ensure the binary is staged into the agent image and PATH includes /system/bin or the tool's install directory."
    : " Install it or add it to PATH.";
  return `${tool} CLI is not available in PATH.${suffix}`;
}

export function missingTerminalToolForCommand(
  command: string,
): TerminalToolName | undefined {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }
  const first = tokens[index]?.replace(/^["']|["']$/g, "");
  if (!first) return undefined;
  const name = path.basename(first) as TerminalToolName;
  if (
    !(TERMINAL_TOOL_NAMES as readonly string[]).includes(name) ||
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
        "Local terminal execution is unavailable in store builds because the OS sandbox blocks spawning local shells and developer CLIs.",
    };
  }

  if (isIosRuntime()) {
    return {
      supported: false,
      reason: "vanilla_mobile",
      message:
        "Local terminal execution is unavailable on iOS because the runtime does not expose shell, coding, or orchestrator subprocess capabilities.",
    };
  }

  if (isAndroidRuntime()) {
    if (runtimeMode() !== "local-yolo") {
      return {
        supported: false,
        reason: "not_local_yolo",
        message:
          "Android direct/AOSP terminal execution requires ELIZA_RUNTIME_MODE=local-yolo so commands run in the local agent environment.",
      };
    }
    const shell = resolveTerminalShell();
    if (!shell.available) {
      return {
        supported: false,
        reason: "missing_shell",
        message:
          shell.warning ??
          "Android direct/AOSP terminal execution requires an executable shell. Set CODING_TOOLS_SHELL or SHELL to a staged shell binary.",
      };
    }
  }

  return { supported: true };
}
