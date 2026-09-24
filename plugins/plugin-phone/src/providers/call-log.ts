/**
 * phoneCallLog provider — read-only Android call-history context.
 *
 * Reading the recent-calls list is state exposure, not an agent operation
 * with side effects. Surfaced as a dynamic provider so the planner can pull
 * call-log context when a question hinges on prior calls. Live operations
 * such as outbound dialing route through the canonical VOICE_CALL surface.
 */

import { type CallLogEntry, Phone } from "@elizaos/capacitor-phone";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { ElizaError } from "@elizaos/core";

const COMPLETE_CALL_LOG_READ_LIMIT = 2_147_483_647;

interface PhoneCallLogEntry {
  id: string;
  number: string;
  cachedName: string;
  date: number;
  durationSeconds: number;
  type: string;
  isNew: boolean;
}

export const phoneCallLogProvider: Provider = {
  name: "phoneCallLog",
  description:
    "Read-only Android call history (number, cached name, timestamp, duration, call type) for resolving recent phone activity.",
  descriptionCompressed: "Phone call log: number, name, date, duration, type.",
  dynamic: true,
  contexts: ["contacts", "messaging"],
  contextGate: { anyOf: ["contacts", "messaging"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const { calls } = await Phone.listRecentCalls({
        limit: COMPLETE_CALL_LOG_READ_LIMIT,
      });
      if (calls.length === COMPLETE_CALL_LOG_READ_LIMIT) {
        throw new ElizaError(
          "Phone call-log provider reached the native bridge boundary; refusing potentially incomplete planner context.",
          {
            code: "NATIVE_PHONE_PROVIDER_INCOMPLETE",
            context: { limit: COMPLETE_CALL_LOG_READ_LIMIT },
          },
        );
      }
      const entries: PhoneCallLogEntry[] = calls.map(
        (call: CallLogEntry): PhoneCallLogEntry => ({
          id: call.id,
          number: call.number,
          cachedName: call.cachedName ?? "",
          date: call.date,
          durationSeconds: call.durationSeconds,
          type: call.type,
          isNew: call.isNew,
        }),
      );

      return {
        text: JSON.stringify({
          phone_call_log: {
            count: entries.length,
            items: entries,
          },
        }),
        values: {
          callLogAvailable: entries.length > 0,
          callLogCount: entries.length,
        },
        data: {
          calls: entries,
          count: entries.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // error-policy:J4 a native call-log failure is explicit planner context,
      // not a successful empty history, and is observable to the owner.
      runtime.reportError?.("phoneCallLog.provider", error);
      return {
        text: JSON.stringify({ phone_call_log: { error: message } }),
        values: {
          callLogAvailable: false,
          callLogCount: 0,
          callLogError: message,
        },
        data: {
          calls: [],
          count: 0,
          error: message,
        },
      };
    }
  },
};
