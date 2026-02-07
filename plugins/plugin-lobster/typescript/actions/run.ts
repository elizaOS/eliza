import {
  type Action,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/specs";
import { createLobsterService } from "../services/lobsterService";
import type { LobsterSuccessEnvelope } from "../types";

interface RunInput {
  pipeline: string;
  argsJson?: string;
  cwd?: string;
}

function isValidRunInput(obj: Record<string, unknown>): boolean {
  return typeof obj.pipeline === "string" && obj.pipeline.length > 0;
}

const EXTRACT_TEMPLATE = `Extract the Lobster pipeline to run from the user's message.

User message: {{text}}

Lobster pipelines are shell-like commands that process data through stages.
Example pipelines:
- gog.gmail.search --query 'newer_than:1d' --max 20 | email.triage
- github.pr.list --state open | pr.review
- rss.fetch --url "..." | content.summarize

Respond with XML containing:
- pipeline: The pipeline command to execute (required)
- argsJson: JSON string of arguments if any (optional)
- cwd: Working directory if specified (optional)

<response>
<pipeline>the pipeline command</pipeline>
<argsJson>{"key": "value"}</argsJson>
<cwd>relative/path</cwd>
</response>`;

async function extractRunInfo(runtime: IAgentRuntime, message: Memory): Promise<RunInput | null> {
  const prompt = EXTRACT_TEMPLATE.replace("{{text}}", message.content.text ?? "");

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  logger.debug("[LobsterRun] Extract result:", result);

  const parsed = parseKeyValueXml(String(result)) as Record<string, unknown> | null;

  if (!parsed || !isValidRunInput(parsed)) {
    logger.error("[LobsterRun] Failed to extract valid run info");
    return null;
  }

  return {
    pipeline: String(parsed.pipeline),
    argsJson: parsed.argsJson ? String(parsed.argsJson) : undefined,
    cwd: parsed.cwd ? String(parsed.cwd) : undefined,
  };
}

const spec = requireActionSpec("LOBSTER_RUN");

export const lobsterRunAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    // Check if lobster is available
    const service = createLobsterService(runtime);
    return await service.isAvailable();
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _stateFromTrigger: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ) => {
    const runInfo = await extractRunInfo(runtime, message);

    if (!runInfo) {
      if (callback) {
        await callback({
          text: "I couldn't determine the pipeline to run. Please specify the Lobster pipeline command.",
          actions: ["LOBSTER_RUN_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to extract pipeline info" };
    }

    try {
      const service = createLobsterService(runtime);
      const envelope = await service.run({
        pipeline: runInfo.pipeline,
        argsJson: runInfo.argsJson,
        cwd: runInfo.cwd,
      });

      if (!envelope.ok) {
        if (callback) {
          await callback({
            text: `Pipeline failed: ${envelope.error.message}`,
            actions: ["LOBSTER_RUN_FAILED"],
            source: message.content.source,
          });
        }
        return { success: false, text: envelope.error.message, envelope };
      }

      const successEnvelope = envelope as LobsterSuccessEnvelope;

      if (successEnvelope.status === "needs_approval") {
        const approval = successEnvelope.requiresApproval;
        const approvalText = approval
          ? `**Approval Required**\n\n${approval.prompt}\n\nItems: ${JSON.stringify(approval.items, null, 2)}\n\nSay "approve" or "reject" to continue.`
          : "Pipeline requires approval to continue.";

        if (callback) {
          await callback({
            text: approvalText,
            actions: ["LOBSTER_NEEDS_APPROVAL"],
            source: message.content.source,
            data: {
              resumeToken: approval?.resumeToken ?? "",
              status: "needs_approval",
            },
          });
        }

        return {
          success: true,
          text: approvalText,
          envelope,
          needsApproval: true,
          resumeToken: approval?.resumeToken,
        };
      }

      const outputSummary =
        successEnvelope.output.length > 0
          ? `\n\nOutput:\n${JSON.stringify(successEnvelope.output, null, 2)}`
          : "";

      const successMessage = `Pipeline completed successfully.${outputSummary}`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["LOBSTER_RUN_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage, envelope };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[LobsterRun] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to run pipeline: ${errorMsg}`,
          actions: ["LOBSTER_RUN_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: errorMsg };
    }
  },

  examples: [],
};

export default lobsterRunAction;
