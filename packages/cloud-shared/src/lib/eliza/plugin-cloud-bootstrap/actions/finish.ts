import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { type ActionWithParams, defineActionParameters } from "../types";
import { normalizeCloudActionArgs } from "../utils/native-planner-guards";

const FINISH_CONTEXTS = ["general", "agent_internal"];
const FINISH_KEYWORDS = [
  "done",
  "finish",
  "complete",
  "final",
  "answer",
  "respond",
  "listo",
  "terminar",
  "completo",
  "final",
  "responder",
  "fini",
  "terminer",
  "complet",
  "repondre",
  "fertig",
  "abschliessen",
  "abschließen",
  "antworten",
  "finito",
  "completo",
  "rispondere",
  "pronto",
  "concluir",
  "responder",
  "完成",
  "结束",
  "回答",
  "完了",
  "終了",
  "回答",
];

function hasSelectedContext(state: State | undefined): boolean {
  const selected = [
    state?.data?.selectedContexts,
    state?.data?.activeContexts,
    state?.data?.contexts,
    state?.values?.selectedContexts,
    state?.values?.activeContexts,
    state?.values?.contexts,
  ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
  return selected.some((context) => FINISH_CONTEXTS.includes(String(context).toLowerCase()));
}

function hasFinishSignal(message: Memory, state?: State): boolean {
  const content = message.content as Record<string, unknown>;
  const params = normalizeCloudActionArgs("FINISH", {
    params: content.params,
    actionParams: content.actionParams,
    actionInput: content.actionInput,
  });
  if (typeof params.response === "string" && params.response.trim()) return true;

  const parts = [content.text, state?.values?.conversationLog, state?.values?.recentMessages]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return FINISH_KEYWORDS.some((keyword) => parts.includes(keyword.toLowerCase()));
}

/**
 * FINISH action - compatibility terminal tool for planners that still emit an
 * explicit final tool call instead of v5 toolCalls: [] plus messageToUser.
 *
 * NOTE: The handler is never called in normal flow. runNativePlannerCore()
 * intercepts action === "FINISH", extracts the response param, and returns
 * directly. The handler exists for registry completeness and non-native-planner
 * contexts.
 *
 * @see cloud-bootstrap-message-service.ts runNativePlannerCore() FINISH intercept
 */
export const finishAction: ActionWithParams = {
  name: "FINISH",
  contexts: FINISH_CONTEXTS,
  contextGate: { anyOf: FINISH_CONTEXTS },
  roleGate: { minRole: "USER" },
  description:
    "Complete the task and respond to the user. Call this when all actions are done " +
    "or the user's request is fully satisfied. Provide your final response in character.",
  parameters: defineActionParameters({
    response: {
      type: "string",
      description:
        "Your final response to the user summarizing what was accomplished, written in character.",
      required: true,
    },
  }),

  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
    hasSelectedContext(state) || hasFinishSignal(message, state),

  // Intercepted by the native planner loop; this is a fallback for non-native-planner contexts.
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const content = message.content as Record<string, unknown>;
    const params = normalizeCloudActionArgs("FINISH", {
      params: content.params,
      actionParams: content.actionParams,
      actionInput: content.actionInput,
    });

    const response = (params.response as string) || "";

    return { success: true, text: response };
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "What's the weather today?" } },
      {
        name: "{{assistant}}",
        content: {
          text: "Task complete.",
          actions: ["FINISH"],
        },
      },
    ],
  ],
};
