import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { StewardService } from "../services/StewardService.js";

/**
 * STEWARD_LIST_APPROVALS — list pending approval requests for the tenant.
 *
 * Helps the agent (or its operator) see what transactions are waiting for review.
 */
export const listApprovalsAction: Action = {
  name: "STEWARD_LIST_APPROVALS",
  description: "List pending transaction approvals that need review",
  similes: [
    "list approvals",
    "pending approvals",
    "what needs approval",
    "approval queue",
    "show pending transactions",
  ],

  parameters: [
    {
      name: "status",
      description: "Filter by status: pending, approved, rejected, or all",
      required: false,
      schema: {
        type: "string",
        enum: ["pending", "approved", "rejected", "all"],
      },
    },
    {
      name: "limit",
      description: "Max results to return (default 10)",
      required: false,
      schema: { type: "number" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me pending approvals",
          action: "STEWARD_LIST_APPROVALS",
        },
      },
    ],
  ] as ActionExample[][],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    const steward = runtime.getService("steward" as any) as StewardService | null;
    return steward?.isConnected() ?? false;
  },

  async handler(
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
  ): Promise<ActionResult> {
    const steward = runtime.getService("steward" as any) as StewardService;
    const params = options?.parameters;

    try {
      const status = (params?.status as string) ?? "pending";
      const limit = (params?.limit as number) ?? 10;

      const approvals = await steward.listApprovals({ status, limit });

      if (approvals.length === 0) {
        return {
          success: true,
          text: `No ${status === "all" ? "" : `${status} `}approvals found.`,
          data: { approvals: [] },
        };
      }

      const formatWei = (wei: string): string => {
        const n = Number(BigInt(wei)) / 1e18;
        return n.toFixed(6);
      };

      const lines = approvals.map((a, i) => {
        const amount = a.value ? `${formatWei(a.value)} ETH` : "unknown amount";
        const to = a.toAddress ? `→ ${a.toAddress.slice(0, 10)}…` : "";
        const agent = a.agentName ?? a.agentId;
        return `${i + 1}. [${a.status}] ${agent} ${to} (${amount}) — tx:${a.txId.slice(0, 8)}…`;
      });

      return {
        success: true,
        text: `📋 **Approvals (${status})**\n${lines.join("\n")}`,
        data: { approvals, count: approvals.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: msg,
        text: `Could not list approvals: ${msg}`,
      };
    }
  },
};
