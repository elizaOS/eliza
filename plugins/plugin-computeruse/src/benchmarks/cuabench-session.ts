import type {
  ComputerActionResult,
  ComputerUseResult,
  DesktopActionParams,
  FileActionResult,
  TerminalActionResult,
  WindowActionResult,
} from "../types.js";
import {
  fromCuaBenchAction,
  type CuaBenchActionInput,
  type CuaBenchConvertedAction,
} from "./cuabench-action-converter.js";

export interface CuaBenchServiceLike {
  executeCommand(
    command: string,
    parameters?: Record<string, unknown>,
  ): Promise<ComputerUseResult>;
  executeDesktopAction(params: DesktopActionParams): Promise<ComputerActionResult>;
}

export interface CuaBenchSessionResult {
  success: boolean;
  done?: boolean;
  waited?: boolean;
  result?: ComputerUseResult;
}

export class CuaBenchSession {
  constructor(private readonly service: CuaBenchServiceLike) {}

  async screenshot(): Promise<string> {
    const result = await this.service.executeDesktopAction({
      action: "screenshot",
    });
    if (!result.success || !result.screenshot) {
      throw new Error(result.error ?? "CuaBench screenshot failed");
    }
    return result.screenshot;
  }

  async executeAction(
    action: CuaBenchActionInput,
  ): Promise<CuaBenchSessionResult> {
    const converted = fromCuaBenchAction(action);
    return this.executeConvertedAction(converted);
  }

  async runCommand(
    command: string,
    options: { cwd?: string; timeoutSeconds?: number } = {},
  ): Promise<TerminalActionResult> {
    return (await this.service.executeCommand("execute_command", {
      command,
      cwd: options.cwd,
      timeoutSeconds: options.timeoutSeconds,
    })) as TerminalActionResult;
  }

  async fileExists(path: string): Promise<boolean> {
    const result = (await this.service.executeCommand("file_exists", {
      path,
    })) as FileActionResult;
    return result.success && result.exists === true;
  }

  async readFile(path: string): Promise<string> {
    const result = (await this.service.executeCommand("file_read", {
      path,
    })) as FileActionResult;
    if (!result.success || typeof result.content !== "string") {
      throw new Error(result.error ?? `Unable to read file: ${path}`);
    }
    return result.content;
  }

  async writeFile(path: string, content: string): Promise<FileActionResult> {
    return (await this.service.executeCommand("file_write", {
      path,
      content,
    })) as FileActionResult;
  }

  async launchWindow(appName: string): Promise<WindowActionResult> {
    return (await this.service.executeCommand("launch", {
      appName,
    })) as WindowActionResult;
  }

  private async executeConvertedAction(
    converted: CuaBenchConvertedAction,
  ): Promise<CuaBenchSessionResult> {
    if (converted.kind === "control") {
      const control = converted.control;
      if (control.kind === "done") {
        return { success: true, done: true };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, control.seconds) * 1000),
      );
      return { success: true, waited: true };
    }

    const result = await this.service.executeDesktopAction(converted.params);
    return { success: result.success, result };
  }
}
