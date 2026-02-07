/**
 * macOS LaunchAgent service manager.
 *
 * Manages services via launchd LaunchAgents for the current user.
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
  return process.env.HOME || `/Users/${process.env.USER || "unknown"}`;
}

/** Get LaunchAgents directory */
function getLaunchAgentsDir(): string {
  return path.join(getHomeDir(), "Library", "LaunchAgents");
}

/** Get plist file path for a service */
function getPlistPath(name: string): string {
  return path.join(getLaunchAgentsDir(), `${name}.plist`);
}

/** Get log directory */
function getLogDir(name: string): string {
  return path.join(getHomeDir(), "Library", "Logs", name);
}

/** Build plist XML content */
function buildPlist(config: ServiceConfig): string {
  const logDir = getLogDir(config.name);
  const stdoutPath = path.join(logDir, "stdout.log");
  const stderrPath = path.join(logDir, "stderr.log");

  const programArgs = config.command
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  let envVars = "";
  if (config.environment && Object.keys(config.environment).length > 0) {
    const entries = Object.entries(config.environment)
      .map(
        ([k, v]) =>
          `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`,
      )
      .join("\n");
    envVars = `  <key>EnvironmentVariables</key>\n  <dict>\n${entries}\n  </dict>\n`;
  }

  let workingDir = "";
  if (config.workingDirectory) {
    workingDir = `  <key>WorkingDirectory</key>\n  <string>${escapeXml(config.workingDirectory)}</string>\n`;
  }

  const keepAlive = config.keepAlive !== false;
  const runAtLoad = config.runAtLoad !== false;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.name)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
${workingDir}${envVars}  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
  <key>KeepAlive</key>
  <${keepAlive}/>
  <key>RunAtLoad</key>
  <${runAtLoad}/>
</dict>
</plist>
`;
}

/** Escape XML special characters */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Parse plist file to extract program arguments */
async function parsePlist(plistPath: string): Promise<ServiceCommand | null> {
  try {
    const content = await fs.readFile(plistPath, "utf8");

    // Extract ProgramArguments
    const argsMatch = content.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    const programArguments: string[] = [];
    if (argsMatch) {
      const stringMatches = argsMatch[1].matchAll(/<string>(.*?)<\/string>/g);
      for (const match of stringMatches) {
        programArguments.push(unescapeXml(match[1]));
      }
    }

    // Extract WorkingDirectory
    const wdMatch = content.match(
      /<key>WorkingDirectory<\/key>\s*<string>(.*?)<\/string>/,
    );
    const workingDirectory = wdMatch ? unescapeXml(wdMatch[1]) : undefined;

    // Extract EnvironmentVariables
    const environment: Record<string, string> = {};
    const envMatch = content.match(
      /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
    );
    if (envMatch) {
      const pairs = envMatch[1].matchAll(
        /<key>(.*?)<\/key>\s*<string>(.*?)<\/string>/g,
      );
      for (const pair of pairs) {
        environment[unescapeXml(pair[1])] = unescapeXml(pair[2]);
      }
    }

    return {
      programArguments,
      workingDirectory,
      environment:
        Object.keys(environment).length > 0 ? environment : undefined,
      sourcePath: plistPath,
    };
  } catch {
    return null;
  }
}

/** Unescape XML entities */
function unescapeXml(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Check if service is loaded */
async function isLoaded(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list"]);
    return stdout.includes(name);
  } catch {
    return false;
  }
}

/** Get service PID if running */
async function getPid(name: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list", name]);
    // Parse output: "PID\tStatus\tLabel" or JSON depending on format
    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*"PID"\s*=\s*(\d+)/);
      if (match) return Number.parseInt(match[1], 10);
      // Tab-separated format
      const parts = line.split("\t");
      if (parts[0] && /^\d+$/.test(parts[0])) {
        return Number.parseInt(parts[0], 10);
      }
    }
  } catch {
    // Service not found
  }
  return undefined;
}

/** macOS LaunchAgent service manager */
export const launchdManager: ServiceManager = {
  label: "LaunchAgent",
  loadedText: "loaded",
  notLoadedText: "not loaded",

  async install(config: ServiceConfig): Promise<ServiceResult> {
    try {
      const plistPath = getPlistPath(config.name);
      const logDir = getLogDir(config.name);

      // Ensure directories exist
      await fs.mkdir(getLaunchAgentsDir(), { recursive: true });
      await fs.mkdir(logDir, { recursive: true });

      // Write plist file
      const plistContent = buildPlist(config);
      await fs.writeFile(plistPath, plistContent, "utf8");

      // Load the service
      await execFileAsync("launchctl", ["load", plistPath]);

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
      const plistPath = getPlistPath(name);

      // Unload if loaded
      if (await isLoaded(name)) {
        try {
          await execFileAsync("launchctl", ["unload", plistPath]);
        } catch {
          // May fail if already unloaded
        }
      }

      // Remove plist file
      try {
        await fs.unlink(plistPath);
      } catch {
        // File may not exist
      }

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
      await execFileAsync("launchctl", ["start", name]);
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
      await execFileAsync("launchctl", ["stop", name]);
      return { success: true, message: `Service ${name} stopped` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async restart(name: string): Promise<ServiceResult> {
    const stopResult = await this.stop(name);
    if (!stopResult.success) {
      // Continue anyway - service might not be running
    }
    return this.start(name);
  },

  async isInstalled(name: string): Promise<boolean> {
    const plistPath = getPlistPath(name);
    try {
      await fs.access(plistPath);
      return true;
    } catch {
      return false;
    }
  },

  async isRunning(name: string): Promise<boolean> {
    const pid = await getPid(name);
    return pid !== undefined;
  },

  async getCommand(name: string): Promise<ServiceCommand | null> {
    const plistPath = getPlistPath(name);
    return parsePlist(plistPath);
  },

  async getRuntime(name: string): Promise<ServiceRuntime> {
    const running = await this.isRunning(name);
    const pid = await getPid(name);
    return {
      running,
      pid,
      platformInfo: {
        plistPath: getPlistPath(name),
        logDir: getLogDir(name),
      },
    };
  },
};
