import type { IAgentRuntime, Service } from "@elizaos/core";
import type { BotState, EventLogEntry } from "../sdk/types.js";

export type Rs2004scapeStateService = Service & {
  getBotState(): BotState | null;
};

export type Rs2004scapeEventLogService = Rs2004scapeStateService & {
  getEventLog(): EventLogEntry[];
};

function hasMethod(service: Service | null, methodName: string): boolean {
  return (
    service !== null && typeof Reflect.get(service, methodName) === "function"
  );
}

function isRs2004scapeStateService(
  service: Service | null,
): service is Rs2004scapeStateService {
  return hasMethod(service, "getBotState");
}

function isRs2004scapeEventLogService(
  service: Service | null,
): service is Rs2004scapeEventLogService {
  return (
    isRs2004scapeStateService(service) && hasMethod(service, "getEventLog")
  );
}

export function getRs2004scapeStateService(
  runtime: IAgentRuntime,
): Rs2004scapeStateService | null {
  const service = runtime.getService("rs_2004scape");
  return isRs2004scapeStateService(service) ? service : null;
}

export function getRs2004scapeEventLogService(
  runtime: IAgentRuntime,
): Rs2004scapeEventLogService | null {
  const service = runtime.getService("rs_2004scape");
  return isRs2004scapeEventLogService(service) ? service : null;
}
