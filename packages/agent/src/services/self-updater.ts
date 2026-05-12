/**
 * Detects the installation method and runs the appropriate upgrade command.
 * Falls back to npm if detection is ambiguous.
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseChannel } from "../config/types.eliza.ts";
import { CHANNEL_DIST_TAGS } from "./update-checker.ts";

const NPM_PACKAGE_NAME = "elizaos";

export type InstallMethod =
  | "npm-global"
  | "bun-global"
  | "homebrew"
  | "snap"
  | "apt"
  | "flatpak"
  | "local-dev"
  | "unknown";

export type UpdateAuthority =
  | "package-manager"
  | "os-package-manager"
  | "developer"
  | "operator";

export type UpdateNextAction =
  | "run-package-manager-command"
  | "run-git-pull"
  | "review-installation"
  | "none";

export interface UpdateResult {
  success: boolean;
  method: InstallMethod;
  command: string;
  previousVersion: string;
  newVersion: string | null;
  error: string | null;
}

export interface UpdateCommandInfo {
  command: string;
  args: string[];
  displayCommand: string;
}

export interface UpdateActionPlan {
  method: InstallMethod;
  authority: UpdateAuthority;
  nextAction: UpdateNextAction;
  canAutoUpdate: boolean;
  canExecuteFromContext: boolean;
  remoteDisplay: boolean;
  command: string | null;
  message: string;
}

function whichSync(binary: string): string | null {
  try {
    return execSync(`which ${binary}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function isLocalDev(): boolean {
  try {
    const rootPkg = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../package.json",
    );
    const content = JSON.parse(fs.readFileSync(rootPkg, "utf-8")) as {
      devDependencies?: Record<string, string>;
    };
    return content.devDependencies !== undefined;
  } catch {
    return false;
  }
}

export function detectInstallMethod(): InstallMethod {
  const elizaBin = whichSync("eliza");

  if (!elizaBin) {
    return isLocalDev() ? "local-dev" : "unknown";
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(elizaBin);
  } catch {
    resolved = elizaBin;
  }

  if (resolved.includes("/Cellar/") || resolved.includes("/homebrew/"))
    return "homebrew";
  if (resolved.includes("/snap/")) return "snap";
  if (resolved.includes("/flatpak/") || resolved.includes("ai.eliza.Eliza"))
    return "flatpak";
  if (resolved.startsWith("/usr/") && !resolved.includes("node_modules"))
    return "apt";
  if (resolved.includes("/.bun/")) return "bun-global";
  if (resolved.includes("node_modules")) return "npm-global";

  return "unknown";
}

export function buildUpdateCommand(
  method: InstallMethod,
  channel: ReleaseChannel,
): UpdateCommandInfo | null {
  const spec = `${NPM_PACKAGE_NAME}@${CHANNEL_DIST_TAGS[channel]}`;

  switch (method) {
    case "npm-global":
      return {
        command: "npm",
        args: ["install", "-g", spec],
        displayCommand: `npm install -g ${spec}`,
      };
    case "bun-global":
      return {
        command: "bun",
        args: ["install", "-g", spec],
        displayCommand: `bun install -g ${spec}`,
      };
    case "homebrew":
      return {
        command: "brew",
        args: ["upgrade", "eliza"],
        displayCommand: "brew upgrade eliza",
      };
    case "snap": {
      // nightly → edge (snap doesn't have a "nightly" channel)
      const snapCh =
        channel === "nightly" ? "edge" : channel === "beta" ? "beta" : "stable";
      return {
        command: "sudo",
        args: ["snap", "refresh", "eliza", `--channel=${snapCh}`],
        displayCommand: `sudo snap refresh eliza --channel=${snapCh}`,
      };
    }
    case "apt":
      return {
        command: "sh",
        args: [
          "-c",
          "sudo apt-get update && sudo apt-get install --only-upgrade -y eliza",
        ],
        displayCommand:
          "sudo apt-get update && sudo apt-get install --only-upgrade -y eliza",
      };
    case "flatpak":
      return {
        command: "flatpak",
        args: ["update", "ai.eliza.Eliza"],
        displayCommand: "flatpak update ai.eliza.Eliza",
      };
    case "local-dev":
      return null;
    case "unknown":
      return {
        command: "npm",
        args: ["install", "-g", spec],
        displayCommand: `npm install -g ${spec}`,
      };
  }
}

function getUpdateAuthority(method: InstallMethod): UpdateAuthority {
  switch (method) {
    case "npm-global":
    case "bun-global":
    case "homebrew":
      return "package-manager";
    case "apt":
    case "snap":
    case "flatpak":
      return "os-package-manager";
    case "local-dev":
      return "developer";
    case "unknown":
      return "operator";
  }
}

function getUpdateMessage(
  method: InstallMethod,
  command: string | null,
  remoteDisplay: boolean,
): string {
  if (remoteDisplay) {
    if (method === "local-dev") {
      return "This is a remote status view. Update the checkout on the host with git pull; no remote execution endpoint is exposed.";
    }
    if (command) {
      return `This is a remote status view. Run "${command}" on the host; no remote execution endpoint is exposed.`;
    }
    return "This is a remote status view. Review the host installation; no remote execution endpoint is exposed.";
  }

  switch (method) {
    case "local-dev":
      return "Local development install detected. Update the checkout with git pull.";
    case "unknown":
      return "Install method is unknown. The CLI will fall back to npm, but reviewing the installation first is recommended.";
    case "apt":
    case "snap":
    case "flatpak":
      return "Updates are delegated to the OS package manager and must run on the host.";
    case "npm-global":
    case "bun-global":
    case "homebrew":
      return "Updates are delegated to the detected package manager.";
  }
}

export function getUpdateActionPlan(
  method: InstallMethod,
  channel: ReleaseChannel,
  options?: { remoteDisplay?: boolean },
): UpdateActionPlan {
  const remoteDisplay = options?.remoteDisplay ?? false;
  const cmdInfo = buildUpdateCommand(method, channel);
  const command =
    cmdInfo?.displayCommand ?? (method === "local-dev" ? "git pull" : null);
  const canAutoUpdate = method !== "local-dev" && cmdInfo !== null;
  const nextAction: UpdateNextAction =
    method === "local-dev"
      ? "run-git-pull"
      : method === "unknown"
        ? "review-installation"
        : cmdInfo
          ? "run-package-manager-command"
          : "none";

  return {
    method,
    authority: getUpdateAuthority(method),
    nextAction,
    canAutoUpdate,
    canExecuteFromContext: canAutoUpdate && !remoteDisplay,
    remoteDisplay,
    command,
    message: getUpdateMessage(method, command, remoteDisplay),
  };
}

function runCommand(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["inherit", "inherit", "pipe"],
      // shell:true removed — all update commands are safe to run directly.
      // The apt case uses sh -c explicitly, so no shell wrapper is needed.
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on("error", (err) => {
      resolve({ exitCode: 1, stderr: err.message });
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}

function readPostUpdateVersion(): string | null {
  try {
    const output = execSync("eliza --version", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    })
      .toString()
      .trim();
    // Version output may include a prefix like "eliza/2.0.0"
    const match = output.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function performUpdate(
  currentVersion: string,
  channel: ReleaseChannel,
  method?: InstallMethod,
): Promise<UpdateResult> {
  method ??= detectInstallMethod();
  const cmdInfo = buildUpdateCommand(method, channel);

  if (!cmdInfo) {
    return {
      success: false,
      method,
      command: "",
      previousVersion: currentVersion,
      newVersion: null,
      error:
        "Cannot auto-update a local development install. Use git pull instead.",
    };
  }

  const commandString = cmdInfo.displayCommand;
  const { exitCode, stderr } = await runCommand(cmdInfo.command, cmdInfo.args);

  if (exitCode !== 0) {
    return {
      success: false,
      method,
      command: commandString,
      previousVersion: currentVersion,
      newVersion: null,
      error: stderr || `Update command exited with code ${exitCode}.`,
    };
  }

  return {
    success: true,
    method,
    command: commandString,
    previousVersion: currentVersion,
    newVersion: readPostUpdateVersion(),
    error: null,
  };
}
