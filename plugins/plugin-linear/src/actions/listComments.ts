import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { LinearService } from "../services/linear";
import type { ListCommentsParameters } from "../types/index.js";
import { validateLinearActionIntent } from "./validate-linear-intent";

export const listCommentsAction: Action = {
  name: "LIST_LINEAR_COMMENTS",
  contexts: ["tasks", "connectors", "automation"],
  contextGate: { anyOf: ["tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  description: "List comments on a Linear issue",
  descriptionCompressed: "list comment Linear issue",
  parameters: [
    {
      name: "issueId",
      description: "Linear issue id or identifier to list comments for.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "Maximum number of comments to return (default 25, max 100).",
      required: false,
      schema: { type: "number" },
    },
  ],
  similes: [
    "get-linear-comments",
    "show-linear-comments",
    "fetch-linear-comments",
  ],

  examples: [
    [
      {
        name: "User",
        content: { text: "Show the comments on ENG-123." },
      },
      {
        name: "Assistant",
        content: {
          text: "Here are the comments on ENG-123.",
          actions: ["LIST_LINEAR_COMMENTS"],
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> =>
    validateLinearActionIntent(runtime, message, state, {
      keywords: ["list", "comments", "linear", "issue"],
      regexAlternation: "list|comments|linear|issue",
    }),

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        throw new Error("Linear service not available");
      }

      const params = _options?.parameters as
        | ListCommentsParameters
        | undefined;
      const issueId = params?.issueId?.trim() ?? "";
      const limit =
        typeof params?.limit === "number"
          ? Math.min(Math.max(1, params.limit), 100)
          : 25;

      if (!issueId) {
        // Try to extract issue id from message text
        const match = message.content.text?.match(/([A-Z]+-\d+)/);
        if (!match) {
          const errorMessage =
            "Please provide an issueId to list comments for.";
          await callback?.({
            text: errorMessage,
            source: message.content.source,
          });
          return { text: errorMessage, success: false };
        }
        const extractedId = match[1];
        const comments = await linearService.listComments(extractedId, limit);
        return formatCommentResult(extractedId, comments, message, callback);
      }

      const comments = await linearService.listComments(issueId, limit);
      return formatCommentResult(issueId, comments, message, callback);
    } catch (error) {
      logger.error("Failed to list comments:", error);
      const errorMessage = `Failed to list comments: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({ text: errorMessage, source: message.content.source });
      return { text: errorMessage, success: false };
    }
  },
};

async function formatCommentResult(
  issueId: string,
  comments: Awaited<ReturnType<LinearService["listComments"]>>,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  if (comments.length === 0) {
    const text = `No comments on issue ${issueId}.`;
    await callback?.({ text, source: message.content.source });
    return { text, success: true, data: { issueId, comments: [] } };
  }

  const lines = await Promise.all(
    comments.map(async (c) => {
      const user = await c.user;
      const name = user?.name ?? "unknown";
      const created = c.createdAt
        ? new Date(c.createdAt).toISOString().slice(0, 10)
        : "?";
      const body = (c.body ?? "").slice(0, 200);
      return `- [${c.id}] ${name} (${created}): ${body}`;
    }),
  );

  const text = `${comments.length} comment(s) on ${issueId}:\n${lines.join("\n")}`;
  await callback?.({ text, source: message.content.source });
  return {
    text,
    success: true,
    data: {
      issueId,
      count: comments.length,
      comments: comments.map((c) => ({ id: c.id })),
    },
  };
}
