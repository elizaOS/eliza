/** Legacy LifeOps composition over the Calendar-owned mutation port. */
import type { IAgentRuntime } from "@elizaos/core";
import { createManagedCalendarMutationPort } from "@elizaos/plugin-calendar/mutations/managed";
import {
  type CalendarMutationService,
  createCalendarMutationPort,
} from "@elizaos/plugin-calendar/mutations/port";
import { LifeOpsService } from "../service.js";

export type { CalendarMutationService };

type Port = ReturnType<typeof createCalendarMutationPort>;
export function createLifeOpsCalendarMutationPort(
  runtime: IAgentRuntime,
  service: CalendarMutationService = new LifeOpsService(runtime),
): Port {
  const canonical = createCalendarMutationPort(runtime, service);
  // Managed owner Google grants are served only by the private host. Route
  // them exactly as the Calendar-owned port service does, so a Life Ops
  // approval never reaches a local provider path that cannot execute it.
  const managed = createManagedCalendarMutationPort(
    process.env,
    fetch,
    String(runtime.agentId),
  );
  if (!managed) return canonical;
  const owns = (request: Parameters<Port["preflight"]>[0]) =>
    managed.owns(
      "grantId" in request.payload ? request.payload.grantId : undefined,
    );
  return {
    ...canonical,
    preflight: (request) =>
      owns(request)
        ? managed.port.preflight(request)
        : canonical.preflight(request),
    execute: (request, preflight) =>
      owns(request)
        ? managed.port.execute(request, preflight)
        : canonical.execute(request, preflight),
  };
}
