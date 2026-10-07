import type { Provider } from "@elizaos/core";
import { CLOCK_ALARM_GUIDANCE } from "../../../services/device-actions/action.ts";
import {
  CLOCK_ALARMS_CAPABILITY,
  validateClockAlarmContext,
} from "../../../services/device-actions/clock-contract.ts";
import { getDeviceActionTurn } from "../../../services/device-actions/service.ts";

/** Current authenticated native state uses the existing full provider-read protocol. */
export const nativeAlarmContextProvider: Provider = {
  name: "CurrentElizaOwnedAlarmSnapshot",
  dynamic: true,
  cacheStable: false,
  alwaysInResponseState: true,
  get: async (runtime, message) => {
    const turn = getDeviceActionTurn();
    if (
      turn?.runtime !== runtime ||
      !turn.credential.capabilities?.includes(CLOCK_ALARMS_CAPABILITY)
    )
      return { text: "" };
    const metadata = message.content.metadata;
    const client =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).clientDevice
        : undefined;
    const observation =
      client && typeof client === "object" && !Array.isArray(client)
        ? (client as Record<string, unknown>).context
        : undefined;
    let snapshot: Record<string, unknown>;
    let original: string | undefined;
    try {
      validateClockAlarmContext(observation);
      snapshot = observation as Record<string, unknown>;
      original = JSON.stringify(snapshot);
    } catch {
      snapshot = {
        alarmsStatus: "unavailable",
        reason: "Missing or invalid current authenticated alarm snapshot",
      };
    }
    return {
      text: `${CLOCK_ALARM_GUIDANCE}\nCurrentElizaOwnedAlarmSnapshot: ${JSON.stringify(snapshot)}`,
      discoveryText:
        "context_discovery: CurrentElizaOwnedAlarmSnapshot\nFull current Eliza alarm records and operation rules are available. Read this provider before listing alarms or choosing targets/time parameters: READ_CONTEXT in routing; RESTORE_CONTEXT with scope=providers in planning/completion. Unread or unavailable is not an empty list. Native approval is still required.",
      data: { snapshot, ...(original === undefined ? {} : { original }) },
    };
  },
};
