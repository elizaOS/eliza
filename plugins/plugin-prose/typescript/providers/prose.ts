import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { type ProseService, createProseService } from "../services/proseService";
import type { ProseStateMode } from "../types";

// Cache service per runtime
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

/**
 * Initialize service for a runtime with bundled skills
 */
export async function initProseService(
  runtime: IAgentRuntime,
  skillsDir?: string,
): Promise<ProseService> {
  const service = getService(runtime);
  await service.init(skillsDir);
  return service;
}

/**
 * Provider that supplies OpenProse VM context
 *
 * This provider is triggered when the user mentions prose-related commands
 * and injects the VM specification into the agent's context, effectively
 * allowing the agent to "become" the OpenProse VM.
 */
export const proseProvider: Provider = {
  name: "prose",
  description: "Provides OpenProse VM context for running and authoring .prose programs",

  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const service = getService(runtime);
    const content =
      typeof message.content === "string" ? message.content : message.content?.text || "";
    const lowerContent = content.toLowerCase();

    // Detect prose-related commands
    const isProseRun =
      lowerContent.includes("prose run") ||
      (lowerContent.includes("run") && lowerContent.includes(".prose"));
    const isProseCompile =
      lowerContent.includes("prose compile") ||
      (lowerContent.includes("validate") && lowerContent.includes(".prose"));
    const isProseHelp =
      lowerContent.includes("prose help") ||
      lowerContent.includes("prose examples") ||
      lowerContent.includes("prose syntax") ||
      lowerContent.includes("how do i write a prose");
    const isProseUpdate = lowerContent.includes("prose update");

    // Not a prose command - return minimal context
    if (!isProseRun && !isProseCompile && !isProseHelp && !isProseUpdate) {
      // Check if there's an active prose run in state
      const activeRunId = state?.proseRunId as string | undefined;
      if (!activeRunId) {
        return `OpenProse is available. Use "prose run <file>" to execute programs, "prose help" for guidance.`;
      }
    }

    // Build context based on what's needed
    const stateMode =
      (state?.proseStateMode as ProseStateMode) ||
      (runtime.getSetting("PROSE_STATE_MODE") as ProseStateMode) ||
      "filesystem";

    try {
      // For help/examples, return the skill spec and help docs
      if (isProseHelp) {
        const skillSpec = service.getSkillSpec();
        const help = service.getHelp();
        const examples = await service.listExamples();

        const parts: string[] = [];

        if (skillSpec) {
          parts.push("## OpenProse Skill\n");
          parts.push(skillSpec);
        }

        if (help) {
          parts.push("\n## Help Documentation\n");
          parts.push(help);
        }

        if (examples.length > 0) {
          parts.push("\n## Available Examples\n");
          parts.push("The following example programs are available:\n");
          for (const ex of examples) {
            parts.push(`- ${ex}`);
          }
          parts.push('\nUse "prose run examples/<name>" to run one.');
        }

        return parts.join("\n");
      }

      // For compile/validate, include compiler spec
      if (isProseCompile) {
        return service.buildVMContext({
          stateMode,
          includeCompiler: true,
          includeGuidance: true,
        });
      }

      // For run or update, return full VM context
      if (isProseRun || isProseUpdate) {
        return service.buildVMContext({
          stateMode,
          includeCompiler: false,
          includeGuidance: false,
        });
      }

      // Default: minimal context
      return `OpenProse VM is ready. Active state mode: ${stateMode}`;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[proseProvider] Error building context: ${errorMsg}`);
      return `OpenProse VM encountered an error: ${errorMsg}`;
    }
  },
};
