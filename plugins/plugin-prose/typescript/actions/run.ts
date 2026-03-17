import * as path from "node:path";
import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { generateText, logger, ModelType } from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/specs";
import { createProseService, type ProseService } from "../services/proseService";
import type { ProseRunResult, ProseStateMode } from "../types";

const spec = requireActionSpec("PROSE_RUN");

// Service cache
const serviceCache = new WeakMap<IAgentRuntime, ProseService>();

function getService(runtime: IAgentRuntime): ProseService {
  let service = serviceCache.get(runtime);
  if (!service) {
    const config = {
      workspaceDir: runtime.getSetting("PROSE_WORKSPACE_DIR") || ".prose",
      defaultStateMode: (runtime.getSetting("PROSE_STATE_MODE") as ProseStateMode) || "filesystem",
    };
    service = createProseService(runtime, config);
    serviceCache.set(runtime, service);
  }
  return service;
}

const EXTRACT_TEMPLATE = `<extraction_task>
Extract the prose run parameters from the user's message.

User message: {{content}}

Respond with ONLY these XML tags:
<file>path/to/program.prose</file>
<state_mode>filesystem|in-context|sqlite|postgres (optional, default: filesystem)</state_mode>
<inputs_json>{"key": "value"} (optional JSON object for program inputs)</inputs_json>
<cwd>/working/directory (optional)</cwd>

If a parameter is not specified, leave the tag empty or omit it.
</extraction_task>`;

/**
 * Parse simple XML key-value pairs from text
 */
function parseKeyValueXml(text: string, keys: string[]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of keys) {
    const regex = new RegExp(`<${key}>([\\s\\S]*?)</${key}>`, "i");
    const match = text.match(regex);
    if (match?.[1]) {
      const value = match[1].trim();
      if (value) {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Build the execution context for a prose run
 */
function buildExecutionContext(
  service: ProseService,
  programContent: string,
  runId: string,
  runDir: string,
  stateMode: ProseStateMode,
  inputs: Record<string, unknown> | undefined
): string {
  const parts: string[] = [];

  // VM loading banner
  parts.push(`╔══════════════════════════════════════════════════════════════╗
║                    OpenProse VM Loading                       ║
╚══════════════════════════════════════════════════════════════╝

Run ID: ${runId}
Run Directory: ${runDir}
State Mode: ${stateMode}
`);

  // VM specification
  const vmContext = service.buildVMContext({
    stateMode,
    includeCompiler: false,
    includeGuidance: false,
  });
  parts.push(vmContext);

  // The program to execute
  parts.push(`
═══════════════════════════════════════════════════════════════
                      PROGRAM TO EXECUTE
═══════════════════════════════════════════════════════════════

\`\`\`prose
${programContent}
\`\`\`
`);

  // Inputs if provided
  if (inputs && Object.keys(inputs).length > 0) {
    parts.push(`
═══════════════════════════════════════════════════════════════
                        PROGRAM INPUTS
═══════════════════════════════════════════════════════════════

\`\`\`json
${JSON.stringify(inputs, null, 2)}
\`\`\`
`);
  }

  // Execution instructions
  parts.push(`
═══════════════════════════════════════════════════════════════
                    EXECUTION INSTRUCTIONS
═══════════════════════════════════════════════════════════════

You are now the OpenProse VM. Your task is to execute the program above
by interpreting each statement according to the VM specification.

1. Parse the program structure (definitions, sessions, control flow)
2. Execute statements in order, using the Task tool for sessions
3. Maintain state in ${runDir} according to ${stateMode} mode
4. Report progress and results back to the user

Begin execution now.
`);

  return parts.join("\n");
}

export const proseRunAction: Action = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes || [],
  examples: spec.examples
    ? spec.examples.map((ex) =>
        ex.map((msg) => ({
          name: msg.role,
          content: { text: msg.content },
        }))
      )
    : [],

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const content =
      typeof message.content === "string" ? message.content : message.content?.text || "";
    const lower = content.toLowerCase();

    // Match "prose run" or mentions of .prose files with run intent
    if (lower.includes("prose run")) return true;
    if (lower.includes("run") && lower.includes(".prose")) return true;
    if (lower.includes("execute") && lower.includes(".prose")) return true;
    if (lower.match(/run\s+[\w./-]+\.prose/)) return true;

    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const service = getService(runtime);
    const content =
      typeof message.content === "string" ? message.content : message.content?.text || "";

    try {
      // Extract parameters
      const extraction = await generateText({
        runtime,
        context: EXTRACT_TEMPLATE.replace("{{content}}", content),
        modelType: ModelType.TEXT_SMALL,
      });

      const params = parseKeyValueXml(extraction, ["file", "state_mode", "inputs_json", "cwd"]);

      if (!params.file) {
        if (callback) {
          callback({
            text: "Please specify a .prose file to run. Example: `prose run workflow.prose`",
            actions: [],
          });
        }
        return false;
      }

      const file = params.file;
      const stateMode =
        (params.state_mode as ProseStateMode) ||
        (runtime.getSetting("PROSE_STATE_MODE") as ProseStateMode) ||
        "filesystem";
      const cwd = params.cwd || process.cwd();

      // Parse inputs if provided
      let inputs: Record<string, unknown> | undefined;
      if (params.inputs_json) {
        try {
          inputs = JSON.parse(params.inputs_json);
        } catch (e) {
          logger.warn(`[PROSE_RUN] Failed to parse inputs_json: ${e}`);
        }
      }

      // Resolve file path
      const filePath = path.isAbsolute(file) ? file : path.join(cwd, file);

      // Check if file exists
      const exists = await service.fileExists(filePath);
      if (!exists) {
        // Check if it's an example reference
        if (file.startsWith("examples/") || !file.includes("/")) {
          const exampleName = file.replace("examples/", "");
          const exampleContent = await service.readExample(exampleName);
          if (exampleContent) {
            // Run as example
            const workspaceDir = await service.ensureWorkspace(cwd);
            const { runId, runDir } = await service.createRunDirectory(
              workspaceDir,
              exampleContent
            );

            const execContext = buildExecutionContext(
              service,
              exampleContent,
              runId,
              runDir,
              stateMode,
              inputs
            );

            if (callback) {
              callback({
                text: `Loading OpenProse VM for example: ${exampleName}\n\nRun ID: ${runId}\n\n${execContext}`,
                actions: ["PROSE_RUN"],
                data: {
                  runId,
                  runDir,
                  stateMode,
                  file: exampleName,
                },
              });
            }

            return true;
          }
        }

        if (callback) {
          callback({
            text: `File not found: ${filePath}\n\nUse \`prose examples\` to see available example programs.`,
            actions: [],
          });
        }
        return false;
      }

      // Read the program
      const programContent = await service.readProseFile(filePath);

      // Set up workspace and run directory
      const workspaceDir = await service.ensureWorkspace(cwd);
      const { runId, runDir } = await service.createRunDirectory(workspaceDir, programContent);

      logger.info(`[PROSE_RUN] Starting run ${runId} for ${file}`);

      // Build the execution context
      const execContext = buildExecutionContext(
        service,
        programContent,
        runId,
        runDir,
        stateMode,
        inputs
      );

      // Return the context - the agent will now "become" the VM
      if (callback) {
        callback({
          text: `Loading OpenProse VM...\n\nRun ID: ${runId}\nProgram: ${file}\nState Mode: ${stateMode}\n\n${execContext}`,
          actions: ["PROSE_RUN"],
          data: {
            runId,
            runDir,
            stateMode,
            file,
          },
        });
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[PROSE_RUN] Error: ${errorMsg}`);

      if (callback) {
        callback({
          text: `Failed to start OpenProse run: ${errorMsg}`,
          actions: [],
        });
      }
      return false;
    }
  },
};
