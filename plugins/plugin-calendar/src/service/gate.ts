import crypto from "node:crypto";
import {
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import type {
  LifeOpsAuditEvent,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  LifeOpsReminderPlan,
} from "@elizaos/shared";
import { fail } from "../internal/errors.js";
import {
  disconnectedGoogleStatus,
  googleAccountStatus,
  listGoogleConnectorAccounts,
  resolveGoogleConnectorAccount,
} from "../internal/google-delegates.js";

/**
 * Cross-domain seam for the calendar service. Calendar owns the calendar event
 * and sync-state tables; the work below belongs to other domains:
 *
 * - **Google connector grants/accounts** are owned by the host's connector
 *   layer (LifeOps' Google service mixin). The default gate resolves them
 *   directly through `@elizaos/plugin-google` connector accounts.
 * - **Reminder plans** and **audit events** are owned by LifeOps' repository.
 *   The default gate no-ops them; LifeOps injects a real implementation via
 *   `CalendarService.setGate(...)` so calendar events keep firing reminders
 *   and writing audit rows.
 */
export interface CalendarHostGate {
  getGoogleConnectorAccounts(
    requestUrl: URL,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]>;
  requireGoogleCalendarGrant(
    requestUrl: URL,
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
  requireGoogleCalendarWriteGrant(
    requestUrl: URL,
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
  createReminderPlan(plan: LifeOpsReminderPlan): Promise<void>;
  updateReminderPlan(plan: LifeOpsReminderPlan): Promise<void>;
  deleteReminderPlan(agentId: string, planId: string): Promise<void>;
  listReminderPlansForOwners(
    agentId: string,
    ownerType: string,
    ownerIds: string[],
  ): Promise<LifeOpsReminderPlan[]>;
  createAuditEvent(event: LifeOpsAuditEvent): Promise<void>;
}

export function createLifeOpsReminderPlan(
  params: Omit<LifeOpsReminderPlan, "id" | "createdAt" | "updatedAt">,
): LifeOpsReminderPlan {
  const timestamp = new Date().toISOString();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsAuditEvent(
  params: Omit<LifeOpsAuditEvent, "id" | "createdAt">,
): LifeOpsAuditEvent {
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

function googleConnectorManagerAvailable(runtime: IAgentRuntime): boolean {
  try {
    const manager = getConnectorAccountManager(runtime) as {
      getProvider?: (id: string) => unknown;
    } | null;
    return Boolean(manager?.getProvider?.("google"));
  } catch {
    return false;
  }
}

async function requireGoogleCalendarGrant(
  runtime: IAgentRuntime,
  agentId: string,
  mode: LifeOpsConnectorMode | undefined,
  side: LifeOpsConnectorSide | undefined,
  grantId: string | undefined,
): Promise<LifeOpsConnectorGrant> {
  if (mode && mode !== "local") {
    fail(410, "Calendar only supports local Google connector accounts.");
  }
  const account = await resolveGoogleConnectorAccount({
    runtime,
    requestedSide: side,
    grantId,
  });
  if (account?.status !== "connected") {
    fail(409, "Google Calendar is not connected.");
  }
  const status = googleAccountStatus({ account, agentId });
  const grant = status.grant;
  if (!grant) {
    fail(409, "Google Calendar is not connected.");
  }
  if (!grant.capabilities.includes("google.calendar.read")) {
    fail(403, "Google Calendar read access has not been granted.");
  }
  return grant;
}

/**
 * Default gate: faithful Google connector resolution, no reminder/audit writes.
 * LifeOps replaces this with its own implementation so calendar events get
 * reminder plans and audit rows.
 */
export function createDefaultCalendarHostGate(
  runtime: IAgentRuntime,
): CalendarHostGate {
  const agentId = runtime.agentId;
  return {
    async getGoogleConnectorAccounts(
      _requestUrl: URL,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus[]> {
      if (!googleConnectorManagerAvailable(runtime)) {
        return side ? [disconnectedGoogleStatus(side)] : [];
      }
      const accounts = await listGoogleConnectorAccounts({
        runtime,
        requestedSide: side,
      });
      if (accounts.length === 0) {
        return side ? [disconnectedGoogleStatus(side)] : [];
      }
      return accounts.map((account) =>
        googleAccountStatus({ account, agentId }),
      );
    },
    requireGoogleCalendarGrant(_requestUrl, mode, side, grantId) {
      return requireGoogleCalendarGrant(runtime, agentId, mode, side, grantId);
    },
    async requireGoogleCalendarWriteGrant(_requestUrl, mode, side, grantId) {
      const grant = await requireGoogleCalendarGrant(
        runtime,
        agentId,
        mode,
        side,
        grantId,
      );
      if (!grant.capabilities.includes("google.calendar.write")) {
        fail(403, "Google Calendar write access has not been granted.");
      }
      return grant;
    },
    async createReminderPlan(): Promise<void> {
      logger.debug(
        "[CalendarService] default gate: createReminderPlan skipped (no host gate registered)",
      );
    },
    async updateReminderPlan(): Promise<void> {},
    async deleteReminderPlan(): Promise<void> {},
    async listReminderPlansForOwners(): Promise<LifeOpsReminderPlan[]> {
      return [];
    },
    async createAuditEvent(): Promise<void> {},
  };
}
