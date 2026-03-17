/**
 * Windows Scheduled Tasks service manager.
 *
 * Manages services via Windows Task Scheduler.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ServiceCommand,
  ServiceConfig,
  ServiceManager,
  ServiceResult,
  ServiceRuntime,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Run schtasks command */
async function schtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("schtasks", args);
}

/** Run PowerShell command */
async function powershell(
  script: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

/** Check if task exists */
async function taskExists(name: string): Promise<boolean> {
  try {
    await schtasks(["/Query", "/TN", name, "/FO", "LIST"]);
    return true;
  } catch {
    return false;
  }
}

/** Get task status */
async function getTaskStatus(
  name: string,
): Promise<{ running: boolean; lastResult?: number }> {
  try {
    const { stdout } = await schtasks([
      "/Query",
      "/TN",
      name,
      "/FO",
      "LIST",
      "/V",
    ]);

    const running = stdout.includes("Running");
    let lastResult: number | undefined;

    const resultMatch = stdout.match(/Last Result:\s*(\d+)/);
    if (resultMatch) {
      lastResult = Number.parseInt(resultMatch[1], 10);
    }

    return { running, lastResult };
  } catch {
    return { running: false };
  }
}

/** Windows Scheduled Task service manager */
export const schtasksManager: ServiceManager = {
  label: "Scheduled Task",
  loadedText: "registered",
  notLoadedText: "not registered",

  async install(config: ServiceConfig): Promise<ServiceResult> {
    try {
      // Build the command
      const [program, ...args] = config.command;
      const _commandLine =
        args.length > 0
          ? `"${program}" ${args.map((a) => `"${a}"`).join(" ")}`
          : `"${program}"`;

      // Create XML for the task (allows more options than command line)
      const xml = buildTaskXml(config);

      // Use PowerShell to register the task with XML
      const script = `
        $xml = @'
${xml}
'@
        Register-ScheduledTask -TaskName "${config.name}" -Xml $xml -Force
      `;

      await powershell(script);

      // Start the task if runAtLoad
      if (config.runAtLoad !== false) {
        await schtasks(["/Run", "/TN", config.name]);
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
      // Stop the task if running
      try {
        await schtasks(["/End", "/TN", name]);
      } catch {
        // May fail if not running
      }

      // Delete the task
      await schtasks(["/Delete", "/TN", name, "/F"]);

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
      await schtasks(["/Run", "/TN", name]);
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
      await schtasks(["/End", "/TN", name]);
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
      // Continue anyway
    }
    // Brief delay before restart
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return this.start(name);
  },

  async isInstalled(name: string): Promise<boolean> {
    return taskExists(name);
  },

  async isRunning(name: string): Promise<boolean> {
    const status = await getTaskStatus(name);
    return status.running;
  },

  async getCommand(name: string): Promise<ServiceCommand | null> {
    try {
      const { stdout } = await powershell(`
        $task = Get-ScheduledTask -TaskName "${name}" -ErrorAction SilentlyContinue
        if ($task) {
          $action = $task.Actions[0]
          @{
            Execute = $action.Execute
            Arguments = $action.Arguments
            WorkingDirectory = $action.WorkingDirectory
          } | ConvertTo-Json
        }
      `);

      const data = JSON.parse(stdout.trim());
      const programArguments = [data.Execute];
      if (data.Arguments) {
        // Parse arguments (simplified)
        programArguments.push(...data.Arguments.split(/\s+/).filter(Boolean));
      }

      return {
        programArguments,
        workingDirectory: data.WorkingDirectory || undefined,
      };
    } catch {
      return null;
    }
  },

  async getRuntime(name: string): Promise<ServiceRuntime> {
    const status = await getTaskStatus(name);

    return {
      running: status.running,
      exitCode: status.lastResult,
      platformInfo: {
        taskName: name,
      },
    };
  },
};

/** Build Task Scheduler XML */
function buildTaskXml(config: ServiceConfig): string {
  const [program, ...args] = config.command;
  const arguments_ = args.length > 0 ? args.map((a) => `"${a}"`).join(" ") : "";
  const description = config.description || `${config.name} service`;
  const workingDir = config.workingDirectory || "";

  // Build restart settings
  const restartInterval = config.restartDelay
    ? `PT${config.restartDelay}S`
    : "PT5S";

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>${restartInterval}</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(program)}</Command>
      ${arguments_ ? `<Arguments>${escapeXml(arguments_)}</Arguments>` : ""}
      ${workingDir ? `<WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>` : ""}
    </Exec>
  </Actions>
</Task>`;
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
