/**
 * Detects the installation method and runs the appropriate upgrade command.
 * Falls back to npm if detection is ambiguous.
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseChannel } from "../config/types.milady";
import { CHANNEL_DIST_TAGS } from "./update-checker";

const NPM_PACKAGE_NAME = "miladyai";

export type InstallMethod =
  | "npm-global"
  | "bun-global"
  | "homebrew"
  | "snap"
  | "apt"
  | "flatpak"
  | "local-dev"
  | "unknown";

export interface UpdateResult {
  success: boolean;
  method: InstallMethod;
  command: string;
  previousVersion: string;
  newVersion: string | null;
  error: string | null;
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
  const miladyBin = whichSync("milady");

  if (!miladyBin) {
    return isLocalDev() ? "local-dev" : "unknown";
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(miladyBin);
  } catch {
    resolved = miladyBin;
  }

  if (resolved.includes("/Cellar/") || resolved.includes("/homebrew/"))
    return "homebrew";
  if (resolved.includes("/snap/")) return "snap";
  if (resolved.includes("/flatpak/") || resolved.includes("ai.milady.Milady"))
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
): { command: string; args: string[] } | null {
  const spec = `${NPM_PACKAGE_NAME}@${CHANNEL_DIST_TAGS[channel]}`;

  switch (method) {
    case "npm-global":
      return { command: "npm", args: ["install", "-g", spec] };
    case "bun-global":
      return { command: "bun", args: ["install", "-g", spec] };
    case "homebrew":
      return { command: "brew", args: ["upgrade", "milady"] };
    case "snap": {
      // nightly → edge (snap doesn't have a "nightly" channel)
      const snapCh =
        channel === "nightly" ? "edge" : channel === "beta" ? "beta" : "stable";
      return {
        command: "sudo",
        args: ["snap", "refresh", "milady", `--channel=${snapCh}`],
      };
    }
    case "apt":
      return {
        command: "sh",
        args: [
          "-c",
          "sudo apt-get update && sudo apt-get install --only-upgrade -y milady",
        ],
      };
    case "flatpak":
      return { command: "flatpak", args: ["update", "ai.milady.Milady"] };
    case "local-dev":
      return null;
    case "unknown":
      return { command: "npm", args: ["install", "-g", spec] };
  }
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
    const output = execSync("milady --version", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    })
      .toString()
      .trim();
    // Version output may include a prefix like "milady/2.0.0"
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

  const commandString = `${cmdInfo.command} ${cmdInfo.args.join(" ")}`;
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
