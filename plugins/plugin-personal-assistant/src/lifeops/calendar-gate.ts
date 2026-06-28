/**
 * LifeOps-backed implementation of the calendar plugin's `CalendarHostGate`.
 *
 * The calendar service (in `@elizaos/plugin-calendar`) owns calendar storage and
 * provider sync, but delegates the cross-domain concerns it cannot own to a
 * gate: Google connector grants (LifeOps' Google connector layer) and
 * reminder-plan / audit persistence (LifeOps' repository). This wires those
 * back to LifeOps so calendar events keep firing reminders and writing audit
 * rows exactly as before the extraction.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type CalendarHostGate,
  CalendarService,
} from "@elizaos/plugin-calendar";
import type {
  LifeOpsAuditEvent,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  LifeOpsReminderPlan,
} from "@elizaos/shared";
import { LifeOpsService } from "./service.js";

/** Structural view of the LifeOps methods the gate forwards to. */
interface CalendarGateHost {
  readonly repository: {
    createReminderPlan(plan: LifeOpsReminderPlan): Promise<void>;
    updateReminderPlan(plan: LifeOpsReminderPlan): Promise<void>;
    deleteReminderPlan(agentId: string, planId: string): Promise<void>;
    listReminderPlansForOwners(
      agentId: string,
      ownerType: string,
      ownerIds: string[],
    ): Promise<LifeOpsReminderPlan[]>;
    createAuditEvent(event: LifeOpsAuditEvent): Promise<void>;
  };
  getGoogleConnectorAccounts(
    requestUrl: URL,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]>;
  requireGoogleCalendarGrant(
    requestUrl: URL,
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): ReturnType<CalendarHostGate["requireGoogleCalendarGrant"]>;
  requireGoogleCalendarWriteGrant(
    requestUrl: URL,
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): ReturnType<CalendarHostGate["requireGoogleCalendarWriteGrant"]>;
}

export function buildLifeOpsCalendarGate(
  runtime: IAgentRuntime,
): CalendarHostGate {
  const host: CalendarGateHost = new LifeOpsService(runtime);
  const repo = host.repository;
  return {
    getGoogleConnectorAccounts: (requestUrl, side) =>
      host.getGoogleConnectorAccounts(requestUrl, side),
    requireGoogleCalendarGrant: (requestUrl, mode, side, grantId) =>
      host.requireGoogleCalendarGrant(requestUrl, mode, side, grantId),
    requireGoogleCalendarWriteGrant: (requestUrl, mode, side, grantId) =>
      host.requireGoogleCalendarWriteGrant(requestUrl, mode, side, grantId),
    createReminderPlan: (plan) => repo.createReminderPlan(plan),
    updateReminderPlan: (plan) => repo.updateReminderPlan(plan),
    deleteReminderPlan: (agentId, planId) =>
      repo.deleteReminderPlan(agentId, planId),
    listReminderPlansForOwners: (agentId, ownerType, ownerIds) =>
      repo.listReminderPlansForOwners(agentId, ownerType, ownerIds),
    createAuditEvent: (event) => repo.createAuditEvent(event),
  };
}

/**
 * Inject the LifeOps-backed gate into the running `CalendarService`. Safe to
 * call after the runtime has finished initializing both plugins; a no-op when
 * the calendar service is not registered.
 */
export function registerLifeOpsCalendarGate(runtime: IAgentRuntime): void {
  const calendar = runtime.getService(
    CalendarService.serviceType,
  ) as CalendarService | null;
  if (!calendar) return;
  calendar.setGate(buildLifeOpsCalendarGate(runtime));
}
