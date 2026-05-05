/**
 * READ_CALL_LOG action — returns recent call history (limit 50).
 *
 * Wraps `@elizaos/capacitor-phone`'s `listRecentCalls`. The native plugin reads
 * Android's `CallLog.Calls` content provider, so this requires the
 * `READ_CALL_LOG` runtime permission to be granted on device. The agent
 * Android runtime adapter adds hosted-app session gating; web/iOS fallback
 * returns an empty list.
 */

import { Phone } from "@elizaos/capacitor-phone";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasRoleAccess } from "@elizaos/shared/eliza-core-roles";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

interface ReadCallLogParams {
  limit?: number;
}

export const readCallLogAction: Action = {
  name: "READ_CALL_LOG",
  similes: ["RECENT_CALLS", "CALL_HISTORY", "LIST_CALLS"],
  description:
    "List the most recent phone calls from the Android call log. Returns up " +
    "to 50 entries (default and maximum), each including number, cached " +
    "contact name, timestamp, duration, and call type (incoming, outgoing, " +
    "missed, voicemail, rejected, blocked, answered_externally). Requires " +
    "the READ_CALL_LOG runtime permission to be granted on device.",
  descriptionCompressed: "List recent Android phone calls (max 50).",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!(await hasRoleAccess(runtime, message, "USER"))) return false;
    return true;
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ReadCallLogParams
      | undefined;
    const requested =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.floor(params.limit)
        : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, requested));

    const { calls } = await Phone.listRecentCalls({ limit });

    return {
      text: `Found ${calls.length} recent call${calls.length === 1 ? "" : "s"}.`,
      success: true,
      data: { calls, limit },
    };
  },

  parameters: [
    {
      name: "limit",
      description:
        "Maximum number of call log entries to return (1-50). Defaults to 50.",
      required: false,
      schema: {
        type: "number" as const,
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
      },
    },
  ],
};
