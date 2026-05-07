/**
 * phoneCallLog provider — read-only Android call-history context.
 *
 * Reading the recent-calls list is state exposure, not an agent operation
 * with side effects. Surfaced as a dynamic provider so the planner can pull
 * call-log context when a question hinges on prior calls. Live operations
 * such as PLACE_CALL remain as actions on the same plugin.
 */

import { Phone } from "@elizaos/capacitor-phone";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

const CALL_LOG_LIMIT = 50;

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
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const { calls } = await Phone.listRecentCalls({ limit: CALL_LOG_LIMIT });
      const entries: PhoneCallLogEntry[] = calls.map((call) => ({
        id: call.id,
        number: call.number,
        cachedName: call.cachedName ?? "",
        date: call.date,
        durationSeconds: call.durationSeconds,
        type: call.type,
        isNew: call.isNew,
      }));

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
          limit: CALL_LOG_LIMIT,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: "",
        values: {
          callLogAvailable: false,
          callLogCount: 0,
          callLogError: message,
        },
        data: {
          calls: [],
          count: 0,
          limit: CALL_LOG_LIMIT,
          error: message,
        },
      };
    }
  },
};
