/** Defines and parses reminder records for the host persistence adapter, preserving canonical domain contracts. */

import crypto from "node:crypto";
import type {
  LifeOpsReminderAttempt,
  LifeOpsReminderPlan,
} from "../../contracts/index.js";
import {
  REMINDER_REVIEW_AT_METADATA_KEY,
  REMINDER_REVIEW_STATUS_METADATA_KEY,
} from "../service-constants.js";
import { parseJsonArray, parseJsonRecord, toNumber, toText } from "../sql.js";
import { isoNow } from "./record-values.js";

export function parseReminderPlan(
  row: Record<string, unknown>,
): LifeOpsReminderPlan {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ownerType: toText(row.owner_type) as LifeOpsReminderPlan["ownerType"],
    ownerId: toText(row.owner_id),
    steps: parseJsonArray(row.steps_json),
    mutePolicy: parseJsonRecord(row.mute_policy_json),
    quietHours: parseJsonRecord(row.quiet_hours_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseReminderAttempt(
  row: Record<string, unknown>,
): LifeOpsReminderAttempt {
  const deliveryMetadata = parseJsonRecord(row.delivery_metadata_json);
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    planId: toText(row.plan_id),
    ownerType: toText(row.owner_type) as LifeOpsReminderAttempt["ownerType"],
    ownerId: toText(row.owner_id),
    occurrenceId: row.occurrence_id ? toText(row.occurrence_id) : null,
    channel: toText(row.channel) as LifeOpsReminderAttempt["channel"],
    stepIndex: toNumber(row.step_index, 0),
    scheduledFor: toText(row.scheduled_for),
    attemptedAt: row.attempted_at ? toText(row.attempted_at) : null,
    outcome: toText(row.outcome) as LifeOpsReminderAttempt["outcome"],
    connectorRef: row.connector_ref ? toText(row.connector_ref) : null,
    deliveryMetadata,
    reviewAt: row.review_at ? toText(row.review_at) : null,
    reviewStatus: row.review_status
      ? (toText(row.review_status) as LifeOpsReminderAttempt["reviewStatus"])
      : null,
  };
}

export function readReminderReviewColumnValues(
  metadata: Record<string, unknown> | null | undefined,
): {
  reviewAt: string | null;
  reviewStatus: LifeOpsReminderAttempt["reviewStatus"];
} {
  const reviewAt = metadata?.[REMINDER_REVIEW_AT_METADATA_KEY];
  const reviewStatus = metadata?.[REMINDER_REVIEW_STATUS_METADATA_KEY];
  return {
    reviewAt: typeof reviewAt === "string" ? reviewAt : null,
    reviewStatus:
      typeof reviewStatus === "string"
        ? (reviewStatus as LifeOpsReminderAttempt["reviewStatus"])
        : null,
  };
}

export function createLifeOpsReminderPlan(
  params: Omit<LifeOpsReminderPlan, "id" | "createdAt" | "updatedAt">,
): LifeOpsReminderPlan {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsReminderAttempt(
  params: Omit<LifeOpsReminderAttempt, "id">,
): LifeOpsReminderAttempt {
  const reviewColumns = readReminderReviewColumnValues(params.deliveryMetadata);
  return {
    ...params,
    id: crypto.randomUUID(),
    reviewAt: params.reviewAt ?? reviewColumns.reviewAt,
    reviewStatus: params.reviewStatus ?? reviewColumns.reviewStatus,
  };
}
