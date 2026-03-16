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

interface ResumeInput {
  token: string;
  approve: boolean;
}

function _isValidResumeInput(obj: Record<string, unknown>): boolean {
  return typeof obj.token === "string" && obj.token.length > 0 && typeof obj.approve === "boolean";
}

const EXTRACT_TEMPLATE = `Extract the approval decision from the user's message.

User message: {{text}}

The user is responding to a Lobster pipeline approval request.

Respond with XML containing:
- token: The resume token (use the provided token: {{resumeToken}})
- approve: true if user approves/confirms/says yes, false if they reject/cancel/say no

<response>
<token>{{resumeToken}}</token>
<approve>true</approve>
</response>`;

async function extractResumeInfo(
  runtime: IAgentRuntime,
  message: Memory,
  resumeToken: string
): Promise<ResumeInput | null> {
  const prompt = EXTRACT_TEMPLATE.replace("{{text}}", message.content.text ?? "").replace(
    /\{\{resumeToken\}\}/g,
    resumeToken
  );

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  logger.debug("[LobsterResume] Extract result:", result);

  const parsed = parseKeyValueXml(String(result)) as Record<string, unknown> | null;

  if (!parsed) {
    return null;
  }

  // Handle approve as string or boolean
  let approve: boolean;
  if (typeof parsed.approve === "boolean") {
    approve = parsed.approve;
  } else if (typeof parsed.approve === "string") {
    approve = parsed.approve.toLowerCase() === "true";
  } else {
    return null;
  }

  const token = parsed.token ? String(parsed.token) : resumeToken;

  if (!token) {
    return null;
  }

  return { token, approve };
}

const spec = requireActionSpec("LOBSTER_RESUME");

export const lobsterResumeAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if there's a pending approval token in the conversation
    const service = createLobsterService(runtime);
    const isAvailable = await service.isAvailable();
    if (!isAvailable) return false;

    // Check if the message or state contains a resume token
    const hasToken = message.content.data?.resumeToken || message.content.text?.includes("resume");
    return !!hasToken;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    stateFromTrigger: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ) => {
    // Get the resume token from message data or state
    const resumeToken =
      (message.content.data?.resumeToken as string) ||
      (stateFromTrigger?.data?.resumeToken as string) ||
      "";

    if (!resumeToken) {
      if (callback) {
        await callback({
          text: "No pending approval found. Run a pipeline first that requires approval.",
          actions: ["LOBSTER_RESUME_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "No resume token available" };
    }

    const resumeInfo = await extractResumeInfo(runtime, message, resumeToken);

    if (!resumeInfo) {
      if (callback) {
        await callback({
          text: "I couldn't determine your approval decision. Please say 'approve' or 'reject'.",
          actions: ["LOBSTER_RESUME_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to extract approval decision" };
    }

    try {
      const service = createLobsterService(runtime);
      const envelope = await service.resume({
        token: resumeInfo.token,
        approve: resumeInfo.approve,
      });

      if (!envelope.ok) {
        if (callback) {
          await callback({
            text: `Resume failed: ${envelope.error.message}`,
            actions: ["LOBSTER_RESUME_FAILED"],
            source: message.content.source,
          });
        }
        return { success: false, text: envelope.error.message, envelope };
      }

      const successEnvelope = envelope as LobsterSuccessEnvelope;

      if (successEnvelope.status === "cancelled") {
        if (callback) {
          await callback({
            text: "Pipeline was cancelled as requested.",
            actions: ["LOBSTER_RESUME_CANCELLED"],
            source: message.content.source,
          });
        }
        return { success: true, text: "Pipeline cancelled", envelope };
      }

      if (successEnvelope.status === "needs_approval") {
        // Another approval checkpoint
        const approval = successEnvelope.requiresApproval;
        const approvalText = approval
          ? `**Another Approval Required**\n\n${approval.prompt}\n\nItems: ${JSON.stringify(approval.items, null, 2)}\n\nSay "approve" or "reject" to continue.`
          : "Pipeline requires another approval.";

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

      const actionText = resumeInfo.approve ? "approved and completed" : "rejected";
      const successMessage = `Pipeline ${actionText} successfully.${outputSummary}`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["LOBSTER_RESUME_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage, envelope };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[LobsterResume] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to resume pipeline: ${errorMsg}`,
          actions: ["LOBSTER_RESUME_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: errorMsg };
    }
  },

  examples: [],
};

export default lobsterResumeAction;
