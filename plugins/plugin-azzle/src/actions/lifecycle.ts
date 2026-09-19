import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { AzzleClient } from "../client.js";

export type AzzleOperation =
  | "post"
  | "claim"
  | "fund"
  | "markDelivered"
  | "release"
  | "complete";

export type AzzleClientFactory = (runtime: IAgentRuntime) => AzzleClient;

function content(options?: HandlerOptions): Record<string, unknown> {
  const values = options as Record<string, unknown> | undefined;
  return (values?.parameters && typeof values.parameters === "object"
    ? values.parameters
    : values ?? {}) as Record<string, unknown>;
}

function taskId(values: Record<string, unknown>): string {
  if (typeof values.taskId !== "string") throw new Error("taskId is required as v2:standard:N or v2:micro:N.");
  return values.taskId;
}

function amount(values: Record<string, unknown>): string {
  if (typeof values.amountAzlWei !== "string") throw new Error("amountAzlWei is required in AZL wei.");
  return values.amountAzlWei;
}

export function createAzzleLifecycleAction(
  operation: AzzleOperation,
  createClient: AzzleClientFactory,
): Action {
  const spec = {
    post: ["POST_AZZLE_TASK", "Post an AZZLE V2 task on Base. The amount is AZL wei, not USDC."],
    claim: ["CLAIM_AZZLE_TASK", "Claim a posted AZZLE V2 task on Base."],
    fund: ["FUND_AZZLE_TASK", "Fund a claimed AZZLE task in AZL wei. Full funding activates it."],
    markDelivered: ["MARK_AZZLE_TASK_DELIVERED", "Mark a fully funded AZZLE task delivered."],
    release: ["RELEASE_AZZLE_ESCROW", "Release AZL wei from a delivered AZZLE task."],
    complete: ["COMPLETE_AZZLE_TASK", "Complete an AZZLE task after release."],
  } as const;
  const [name, description] = spec[operation];
  return {
    name,
    description,
    parameters: [
      ...(operation === "post"
        ? [
            { name: "totalAmountAzlWei", description: "Positive AZL wei amount.", required: true, schema: { type: "string", pattern: "^[1-9][0-9]*$" } },
            { name: "deadline", description: "Future Unix timestamp.", required: true, schema: { type: "number", minimum: 1 } },
          ]
        : [
            { name: "taskId", description: "Canonical V2 ID: v2:standard:N or v2:micro:N.", required: true, schema: { type: "string", pattern: "^v2:(standard|micro):[1-9][0-9]*$" } },
            ...((operation === "fund" || operation === "release")
              ? [{ name: "amountAzlWei", description: "Positive AZL wei amount.", required: true, schema: { type: "string", pattern: "^[1-9][0-9]*$" } }]
              : []),
          ]),
    ],
    validate: async (runtime) => Boolean(runtime.getSetting("AZZLE_BASE_RPC_URL")),
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      try {
        const values = content(options);
        const client = createClient(runtime);
        const hash = await ({
          post: () => client.post(String(values.totalAmountAzlWei ?? ""), Number(values.deadline)),
          claim: () => client.claim(taskId(values)),
          fund: () => client.fund(taskId(values), amount(values)),
          markDelivered: () => client.markDelivered(taskId(values)),
          release: () => client.release(taskId(values), amount(values)),
          complete: () => client.complete(taskId(values)),
        }[operation])();
        const text = `${name} submitted on Base. Transaction hash: ${hash}`;
        await callback?.({ text, source: message.content.source, actions: [name] });
        return { success: true, text, data: { transactionHash: hash, operation } };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown AZZLE error";
        const text = `${name} failed: ${detail}`;
        await callback?.({ text, source: message.content.source, actions: [name] });
        return { success: false, text, data: { operation, error: detail } };
      }
    },
  };
}
