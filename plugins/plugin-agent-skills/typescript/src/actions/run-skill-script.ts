/**
 * Run Skill Script Action
 *
 * Executes scripts bundled with installed skills.
 * Scripts run via bash without loading their contents into context.
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ActionResult,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import { spawn } from "child_process";
import * as path from "path";

export const runSkillScriptAction: Action = {
  name: "RUN_SKILL_SCRIPT",
  similes: ["EXECUTE_SKILL_SCRIPT", "SKILL_SCRIPT"],
  description:
    "Execute a script bundled with an installed skill. Provide skill slug and script name.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const service = await runtime.getService<AgentSkillsService>(
      "AGENT_SKILLS_SERVICE",
    );
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = await runtime.getService<AgentSkillsService>(
        "AGENT_SKILLS_SERVICE",
      );
      if (!service) {
        throw new Error("AgentSkillsService not available");
      }

      // Parse options
      const opts = options as
        | { skillSlug?: string; script?: string; args?: string[] }
        | undefined;
      const skillSlug = opts?.skillSlug;
      const scriptName = opts?.script;
      const args = opts?.args || [];

      if (!skillSlug || !scriptName) {
        return {
          success: false,
          error: new Error("Both skillSlug and script are required"),
        };
      }

      // Get script path
      const scriptPath = service.getScriptPath(skillSlug, scriptName);
      if (!scriptPath) {
        return {
          success: false,
          error: new Error(
            `Script "${scriptName}" not found in skill "${skillSlug}"`,
          ),
        };
      }

      // Execute script
      runtime.logger.info(`AgentSkills: Executing ${skillSlug}/${scriptName}`);

      const result = await executeScript(scriptPath, args);

      const text = result.success
        ? `Script executed successfully:\n\`\`\`\n${result.stdout}\n\`\`\``
        : `Script failed:\n\`\`\`\n${result.stderr}\n\`\`\``;

      if (callback) {
        await callback({ text });
      }

      return {
        success: result.success,
        text,
        data: {
          scriptPath,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({ text: `Error executing script: ${errorMsg}` });
      }
      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMsg),
      };
    }
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: { text: "Run the rotate script from pdf-skill" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll run the rotate_pdf.py script from the pdf-skill.",
          actions: ["RUN_SKILL_SCRIPT"],
        },
      },
    ],
  ],
};

interface ScriptResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function executeScript(
  scriptPath: string,
  args: string[],
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const ext = path.extname(scriptPath).toLowerCase();
    let cmd: string;
    let cmdArgs: string[];

    switch (ext) {
      case ".py":
        cmd = "python3";
        cmdArgs = [scriptPath, ...args];
        break;
      case ".sh":
        cmd = "bash";
        cmdArgs = [scriptPath, ...args];
        break;
      case ".js":
        cmd = "node";
        cmdArgs = [scriptPath, ...args];
        break;
      default:
        // Try to execute directly
        cmd = scriptPath;
        cmdArgs = args;
    }

    const child = spawn(cmd, cmdArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000, // 1 minute timeout
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({
        success: code === 0,
        exitCode: code || 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on("error", (error) => {
      resolve({
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: error.message,
      });
    });
  });
}

export default runSkillScriptAction;
