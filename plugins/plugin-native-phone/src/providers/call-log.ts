/**
 * phoneCallLog provider — read-only Android call-history context.
 *
 * Reading the recent-calls list is state exposure, not an agent operation
 * with side effects. Surfaced as a dynamic provider so the planner can pull
 * call-log context when a question hinges on prior calls. Live operations
 * such as outbound dialing route through the canonical VOICE_CALL surface.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { type CallLogEntry, Phone } from "@elizaos/plugin-native-phone/bridge";

// Provider render bound, matching the Phone view's max. The
// native query already orders newest-first, so the newest window
// is exactly the recent phone activity this provider exists to
// surface. The view's explicit complete-read path is untouched.
const PHONE_CALL_LOG_PROVIDER_LIMIT = 200;

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
        limit: PHONE_CALL_LOG_PROVIDER_LIMIT,
      });
      // Hitting the limit is the normal truncated case here, not
      // an incomplete-context error: the provider's contract is
      // recent activity, and older calls stay reachable through
      // the Phone view's explicit complete read.
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
