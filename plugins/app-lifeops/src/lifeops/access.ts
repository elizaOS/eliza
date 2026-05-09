/**
 * LifeOps owner-access guards and Google connector capability lookup.
 *
 * Validate-time predicate (`hasLifeOpsAccess`) gates every LifeOps action on
 * owner ownership of the agent. The Google capability snapshot is the single
 * source of truth that callsites use to decide whether a Google-backed
 * subaction is allowed (read-only vs write, Gmail vs Calendar, etc.) and to
 * render the matching unavailable-message when access is missing.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type { Action, Memory } from "@elizaos/core";
import type { LifeOpsGoogleConnectorStatus } from "../contracts/index.js";
import type { LifeOpsService } from "./service.js";

export const INTERNAL_URL = new URL("http://127.0.0.1/");

export async function hasLifeOpsAccess(
  runtime: Parameters<NonNullable<Action["validate"]>>[0],
  message: Memory,
): Promise<boolean> {
  if (
    !runtime ||
    typeof runtime.agentId !== "string" ||
    !message ||
    typeof message.entityId !== "string" ||
    message.entityId.length === 0
  ) {
    return false;
  }
  return hasOwnerAccess(runtime, message);
}

export type GoogleCapabilityStatus = {
  status: LifeOpsGoogleConnectorStatus | null;
  connected: boolean;
  hasCalendarRead: boolean;
  hasCalendarWrite: boolean;
  hasGmailTriage: boolean;
  hasGmailSend: boolean;
  hasGmailManage: boolean;
};

export async function getGoogleCapabilityStatus(
  service: LifeOpsService,
): Promise<GoogleCapabilityStatus> {
  let status: LifeOpsGoogleConnectorStatus;
  try {
    status = await service.getGoogleConnectorStatus(INTERNAL_URL);
  } catch {
    return {
      status: null,
      connected: false,
      hasCalendarRead: false,
      hasCalendarWrite: false,
      hasGmailTriage: false,
      hasGmailSend: false,
      hasGmailManage: false,
    };
  }
  const capabilities = new Set(status.grantedCapabilities ?? []);
  return {
    status,
    connected: status.connected,
    hasCalendarRead:
      capabilities.has("google.calendar.read") ||
      capabilities.has("google.calendar.write"),
    hasCalendarWrite: capabilities.has("google.calendar.write"),
    hasGmailTriage: capabilities.has("google.gmail.triage"),
    hasGmailSend: capabilities.has("google.gmail.send"),
    hasGmailManage: capabilities.has("google.gmail.manage"),
  };
}

export function calendarReadUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Google Calendar access is limited. Reconnect Google in LifeOps settings to grant calendar access."
    : "Google Calendar is not connected. Connect Google in LifeOps settings to use calendar actions.";
}

export function calendarWriteUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Google Calendar write access is not granted. Reconnect Google in LifeOps settings to allow calendar event creation."
    : "Google Calendar is not connected. Connect Google in LifeOps settings before creating calendar events.";
}

export function gmailReadUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Gmail access is limited. Reconnect Google in LifeOps settings to grant Gmail triage and search access."
    : "Gmail is not connected. Connect Google in LifeOps settings to use Gmail actions.";
}

export function gmailSendUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Gmail send access is not granted. Reconnect Google in LifeOps settings to allow email sending."
    : "Gmail is not connected. Connect Google in LifeOps settings before sending email.";
}
