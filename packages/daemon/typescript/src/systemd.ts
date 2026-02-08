/**
 * Linux systemd user service manager.
 *
 * Manages services via systemd user units.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ServiceCommand,
  ServiceConfig,
  ServiceManager,
  ServiceResult,
  ServiceRuntime,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Get home directory */
function getHomeDir(): string {
  return process.env.HOME || `/home/${process.env.USER || "unknown"}`;
}

/** Get systemd user units directory */
function getUnitsDir(): string {
  return path.join(getHomeDir(), ".config", "systemd", "user");
}

/** Get unit file path for a service */
function getUnitPath(name: string): string {
  return path.join(getUnitsDir(), `${name}.service`);
}

/** Get log directory */
function getLogDir(name: string): string {
  return path.join(getHomeDir(), ".local", "share", name, "logs");
}

/** Build systemd unit file content */
function buildUnit(config: ServiceConfig): string {
  const description = config.description || `${config.name} service`;
  const execStart = config.command.map(escapeSystemd).join(" ");
  const restart = config.restartOnFailure !== false ? "on-failure" : "no";
  const restartSec = config.restartDelay || 5;

  let envLines = "";
  if (config.environment) {
    envLines = Object.entries(config.environment)
      .map(([k, v]) => `Environment="${k}=${escapeSystemd(v)}"`)
      .join("\n");
  }

  let workingDir = "";
  if (config.workingDirectory) {
    workingDir = `WorkingDirectory=${config.workingDirectory}`;
  }

  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
${workingDir}
${envLines}
Restart=${restart}
RestartSec=${restartSec}

[Install]
WantedBy=default.target
`.replace(/\n{3,}/g, "\n\n");
}

/** Escape systemd special characters */
function escapeSystemd(str: string): string {
  // Escape quotes and backslashes
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Parse unit file to extract ExecStart */
async function parseUnit(unitPath: string): Promise<ServiceCommand | null> {
  try {
    const content = await fs.readFile(unitPath, "utf8");

    let execStart = "";
    let workingDirectory: string | undefined;
    const environment: Record<string, string> = {};

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length);
      } else if (line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length);
      } else if (line.startsWith("Environment=")) {
        const envPart = line.slice("Environment=".length);
        // Parse "KEY=value" format
        const match = envPart.match(/^"?([^=]+)=(.*)$/);
        if (match) {
          const key = match[1];
          let value = match[2];
          // Remove trailing quote if present
          if (value.endsWith('"')) value = value.slice(0, -1);
          environment[key] = value;
        }
      }
    }

    // Parse ExecStart into arguments
    const programArguments = parseExecStart(execStart);

    return {
      programArguments,
      workingDirectory,
      environment:
        Object.keys(environment).length > 0 ? environment : undefined,
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

/** Parse ExecStart line into arguments */
function parseExecStart(execStart: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let isEscaped = false;

  for (const char of execStart) {
    if (isEscaped) {
      current += char;
      isEscaped = false;
    } else if (char === "\\") {
      isEscaped = true;
    } else if (char === '"') {
      inQuote = !inQuote;
    } else if (char === " " && !inQuote) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);

  return args;
}

/** Run systemctl command */
async function systemctl(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("systemctl", ["--user", ...args]);
}

/** Check if service is enabled */
async function isEnabled(name: string): Promise<boolean> {
  try {
    const { stdout } = await systemctl(["is-enabled", `${name}.service`]);
    return stdout.trim() === "enabled";
  } catch {
    return false;
  }
}

/** Check if service is active/running */
async function isActive(name: string): Promise<boolean> {
  try {
    const { stdout } = await systemctl(["is-active", `${name}.service`]);
    return stdout.trim() === "active";
  } catch {
    return false;
  }
}

/** Get service PID */
async function getPid(name: string): Promise<number | undefined> {
  try {
    const { stdout } = await systemctl([
      "show",
      `${name}.service`,
      "--property=MainPID",
    ]);
    const match = stdout.match(/MainPID=(\d+)/);
    if (match && match[1] !== "0") {
      return Number.parseInt(match[1], 10);
    }
  } catch {
    // Service not found
  }
  return undefined;
}

/** Enable lingering for current user (allows services to run without login) */
async function enableLinger(): Promise<boolean> {
  try {
    await execFileAsync("loginctl", ["enable-linger"]);
    return true;
  } catch {
    return false;
  }
}

/** Linux systemd service manager */
export const systemdManager: ServiceManager = {
  label: "systemd",
  loadedText: "enabled",
  notLoadedText: "disabled",

  async install(config: ServiceConfig): Promise<ServiceResult> {
    try {
      const unitPath = getUnitPath(config.name);
      const logDir = getLogDir(config.name);

      // Ensure directories exist
      await fs.mkdir(getUnitsDir(), { recursive: true });
      await fs.mkdir(logDir, { recursive: true });

      // Write unit file
      const unitContent = buildUnit(config);
      await fs.writeFile(unitPath, unitContent, "utf8");

      // Reload systemd
      await systemctl(["daemon-reload"]);

      // Enable the service
      await systemctl(["enable", `${config.name}.service`]);

      // Enable lingering so service runs without login
      await enableLinger();

      // Start the service if runAtLoad
      if (config.runAtLoad !== false) {
        await systemctl(["start", `${config.name}.service`]);
      }

      return { success: true, message: `Service ${config.name} installed` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async uninstall(name: string): Promise<ServiceResult> {
    try {
      // Stop the service
      try {
        await systemctl(["stop", `${name}.service`]);
      } catch {
        // May fail if not running
      }

      // Disable the service
      try {
        await systemctl(["disable", `${name}.service`]);
      } catch {
        // May fail if not enabled
      }

      // Remove unit file
      const unitPath = getUnitPath(name);
      try {
        await fs.unlink(unitPath);
      } catch {
        // File may not exist
      }

      // Reload systemd
      await systemctl(["daemon-reload"]);

      return { success: true, message: `Service ${name} uninstalled` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async start(name: string): Promise<ServiceResult> {
    try {
      await systemctl(["start", `${name}.service`]);
      return { success: true, message: `Service ${name} started` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async stop(name: string): Promise<ServiceResult> {
    try {
      await systemctl(["stop", `${name}.service`]);
      return { success: true, message: `Service ${name} stopped` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async restart(name: string): Promise<ServiceResult> {
    try {
      await systemctl(["restart", `${name}.service`]);
      return { success: true, message: `Service ${name} restarted` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async isInstalled(name: string): Promise<boolean> {
    const unitPath = getUnitPath(name);
    try {
      await fs.access(unitPath);
      return true;
    } catch {
      return false;
    }
  },

  async isRunning(name: string): Promise<boolean> {
    return isActive(name);
  },

  async getCommand(name: string): Promise<ServiceCommand | null> {
    const unitPath = getUnitPath(name);
    return parseUnit(unitPath);
  },

  async getRuntime(name: string): Promise<ServiceRuntime> {
    const running = await isActive(name);
    const pid = await getPid(name);
    const enabled = await isEnabled(name);

    return {
      running,
      pid,
      platformInfo: {
        unitPath: getUnitPath(name),
        enabled,
      },
    };
  },
};
