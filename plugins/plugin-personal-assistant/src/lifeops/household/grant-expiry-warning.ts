/**
 * Structural pre-expiry warnings for scoped household access grants.
 *
 * Each expiring grant owns one durable ScheduledTask watcher. A grant-backed
 * gate rechecks exact identity, revocation, and expiry immediately before
 * dispatch; the task carries no broader household context and never extends
 * the grant it describes.
 */
import crypto from "node:crypto";
import type {
  ScheduledTask,
  ScheduledTaskRunnerHandle,
  ScheduledTaskStatus,
  TaskGateRegistry,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import type { HouseholdCoordinationRepository } from "./repository.js";
import {
  type HouseholdAccessGrant,
  type HouseholdAccessScope,
  HouseholdCoordinationError,
  type HouseholdRole,
  isHouseholdAccessScope,
  isHouseholdRole,
} from "./types.js";

export const HOUSEHOLD_GRANT_EXPIRY_WARNING_GATE = "household_grant_preexpiry";
export const HOUSEHOLD_GRANT_EXPIRY_WARNING_LEAD_MS = 24 * 60 * 60 * 1000;
const WARNING_METADATA_KEY = "householdGrantExpiryWarning";
const CLAIM_LEASE_MS = 60_000;
const TERMINAL_TASK_STATES: ReadonlySet<ScheduledTaskStatus> = new Set([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

export interface HouseholdGrantExpiryWarningIdentity {
  version: 1;
  grantId: string;
  principalEntityId: string;
  relationshipId: string | null;
  role: HouseholdRole;
  subjectEntityIds: string[];
  scopes: HouseholdAccessScope[];
  warningAt: string;
  expiresAt: string;
  autoExtend: false;
  disclosure: "grant_identity_only";
}

export type HouseholdGrantExpiryWarningReceipt =
  | {
      outcome: "ready";
      grantId: string;
      scheduledTaskId: string;
      taskState: ScheduledTaskStatus;
      warningAt: string;
      expiresAt: string;
      deduplicated: boolean;
      autoExtend: false;
    }
  | {
      outcome: "not_applicable";
      grantId: string;
      reason: "no_expiry" | "revoked" | "expired";
      autoExtend: false;
    }
  | {
      outcome: "cancelled";
      grantId: string;
      scheduledTaskId: string | null;
      taskState: ScheduledTaskStatus | "not_scheduled";
      autoExtend: false;
    }
  | {
      outcome: "deferred";
      grantId: string;
      reason: "active_claim";
      retryAt: string;
      autoExtend: false;
    }
  | {
      outcome: "deferred";
      grantId: string;
      reason: "materialization_failure" | "cancellation_failure";
      failedAt: string;
      autoExtend: false;
    };

function canonical(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function idempotencyKey(grantId: string, expiresAt: string): string {
  return `household:grant-expiry-warning:${grantId}:${expiresAt}`;
}

function identityFor(
  grant: HouseholdAccessGrant,
  now: Date,
): HouseholdGrantExpiryWarningIdentity | null {
  if (!grant.expiresAt) return null;
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new HouseholdCoordinationError(
      "Household grant has an invalid expiry timestamp",
      "HOUSEHOLD_INVALID_CONTRACT",
      { grantId: grant.id, expiresAt: grant.expiresAt },
    );
  }
  const warningAtMs = Math.max(
    now.getTime(),
    expiresAtMs - HOUSEHOLD_GRANT_EXPIRY_WARNING_LEAD_MS,
  );
  return {
    version: 1,
    grantId: grant.id,
    principalEntityId: grant.principalEntityId,
    relationshipId: grant.relationshipId,
    role: grant.role,
    subjectEntityIds: canonical(grant.subjectEntityIds),
    scopes: canonical(grant.scopes) as HouseholdAccessScope[],
    warningAt: new Date(warningAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    autoExtend: false,
    disclosure: "grant_identity_only",
  };
}

function taskIdentity(
  task: ScheduledTask,
): HouseholdGrantExpiryWarningIdentity {
  const raw = task.metadata?.[WARNING_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HouseholdCoordinationError(
      "Household grant expiry warning is missing typed metadata",
      "HOUSEHOLD_INVALID_CONTRACT",
      { taskId: task.taskId },
    );
  }
  const value = raw as Record<string, unknown>;
  const subjectEntityIds = value.subjectEntityIds;
  const scopes = value.scopes;
  if (
    value.version !== 1 ||
    typeof value.grantId !== "string" ||
    typeof value.principalEntityId !== "string" ||
    !(
      value.relationshipId === null || typeof value.relationshipId === "string"
    ) ||
    typeof value.role !== "string" ||
    !isHouseholdRole(value.role) ||
    !Array.isArray(subjectEntityIds) ||
    subjectEntityIds.some((entry) => typeof entry !== "string") ||
    !Array.isArray(scopes) ||
    scopes.some(
      (entry) => typeof entry !== "string" || !isHouseholdAccessScope(entry),
    ) ||
    typeof value.warningAt !== "string" ||
    !Number.isFinite(Date.parse(value.warningAt)) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    value.autoExtend !== false ||
    value.disclosure !== "grant_identity_only"
  ) {
    throw new HouseholdCoordinationError(
      "Household grant expiry warning metadata is invalid",
      "HOUSEHOLD_INVALID_CONTRACT",
      { taskId: task.taskId },
    );
  }
  return {
    version: 1,
    grantId: value.grantId,
    principalEntityId: value.principalEntityId,
    relationshipId: value.relationshipId,
    role: value.role,
    subjectEntityIds: canonical(subjectEntityIds as string[]),
    scopes: canonical(scopes as string[]) as HouseholdAccessScope[],
    warningAt: new Date(value.warningAt).toISOString(),
    expiresAt: new Date(value.expiresAt).toISOString(),
    autoExtend: false,
    disclosure: "grant_identity_only",
  };
}

function assertTaskContract(
  task: ScheduledTask,
  expected: HouseholdGrantExpiryWarningIdentity,
): void {
  const actual = taskIdentity(task);
  const gate = task.shouldFire?.gates.find(
    (candidate) => candidate.kind === HOUSEHOLD_GRANT_EXPIRY_WARNING_GATE,
  );
  if (
    task.kind !== "watcher" ||
    task.trigger.kind !== "once" ||
    task.trigger.atIso !== expected.warningAt ||
    task.subject?.kind !== "self" ||
    task.subject.id !== SELF_ENTITY_ID ||
    task.contextRequest !== undefined ||
    task.output?.destination !== "in_app_card" ||
    task.idempotencyKey !==
      idempotencyKey(expected.grantId, expected.expiresAt) ||
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    JSON.stringify(gate?.params) !== JSON.stringify(expected)
  ) {
    throw new HouseholdCoordinationError(
      "Household grant expiry warning task does not match its grant identity",
      "HOUSEHOLD_INVALID_CONTRACT",
      { grantId: expected.grantId, taskId: task.taskId },
    );
  }
}

function buildTask(
  identity: HouseholdGrantExpiryWarningIdentity,
  agentId: string,
): Omit<ScheduledTask, "taskId" | "state"> {
  const subjects = identity.subjectEntityIds.join(", ");
  const scopes = identity.scopes.join(", ");
  return {
    kind: "watcher",
    promptInstructions: [
      `Warn the owner that household access grant ${identity.grantId} for principal entity ${identity.principalEntityId}`,
      `covers only subject entities [${subjects}] and scopes [${scopes}], and expires at ${identity.expiresAt}.`,
      "State that access will not extend automatically. Do not expose calendar contents, locations, messages, health information, or any person or subject outside this exact grant.",
    ].join(" "),
    trigger: { kind: "once", atIso: identity.warningAt },
    priority: "high",
    shouldFire: {
      compose: "first_deny",
      gates: [
        {
          kind: HOUSEHOLD_GRANT_EXPIRY_WARNING_GATE,
          params: identity,
        },
      ],
    },
    output: {
      destination: "in_app_card",
      target: `entity:${SELF_ENTITY_ID}`,
    },
    subject: { kind: "self", id: SELF_ENTITY_ID },
    idempotencyKey: idempotencyKey(identity.grantId, identity.expiresAt),
    respectsGlobalPause: false,
    source: "plugin",
    createdBy: agentId,
    ownerVisible: true,
    metadata: {
      [WARNING_METADATA_KEY]: identity,
    },
    executionProfile: "notify-only",
  };
}

export async function ensureHouseholdGrantExpiryWarning(input: {
  grant: HouseholdAccessGrant;
  repository: HouseholdCoordinationRepository;
  scheduledTasks: ScheduledTaskRunnerHandle;
  now: Date;
}): Promise<HouseholdGrantExpiryWarningReceipt> {
  if (input.grant.revokedAt) {
    return {
      outcome: "not_applicable",
      grantId: input.grant.id,
      reason: "revoked",
      autoExtend: false,
    };
  }
  const identity = identityFor(input.grant, input.now);
  if (!identity) {
    return {
      outcome: "not_applicable",
      grantId: input.grant.id,
      reason: "no_expiry",
      autoExtend: false,
    };
  }
  if (Date.parse(identity.expiresAt) <= input.now.getTime()) {
    return {
      outcome: "not_applicable",
      grantId: input.grant.id,
      reason: "expired",
      autoExtend: false,
    };
  }

  const attemptToken = crypto.randomUUID();
  const claim = await input.repository.claimGrantExpiryWarning({
    grantId: identity.grantId,
    attemptToken,
    now: input.now.toISOString(),
    leaseExpiresAt: new Date(
      input.now.getTime() + CLAIM_LEASE_MS,
    ).toISOString(),
  });
  if (claim.kind === "busy") {
    return {
      outcome: "deferred",
      grantId: identity.grantId,
      reason: "active_claim",
      retryAt: claim.leaseExpiresAt,
      autoExtend: false,
    };
  }

  try {
    const tasks = await input.scheduledTasks.list({ kind: "watcher" });
    let task =
      claim.kind === "complete"
        ? tasks.find((candidate) => candidate.taskId === claim.scheduledTaskId)
        : tasks.find(
            (candidate) =>
              candidate.idempotencyKey ===
              idempotencyKey(identity.grantId, identity.expiresAt),
          );
    const matching = tasks.filter(
      (candidate) =>
        candidate.idempotencyKey ===
        idempotencyKey(identity.grantId, identity.expiresAt),
    );
    if (matching.length > 1) {
      throw new HouseholdCoordinationError(
        "Multiple ScheduledTasks share one household grant warning identity",
        "HOUSEHOLD_INVALID_CONTRACT",
        { grantId: identity.grantId },
      );
    }
    const deduplicated = Boolean(task);
    if (!task) {
      task = await input.scheduledTasks.schedule(
        buildTask(identity, input.grant.agentId),
      );
    }
    assertTaskContract(task, identity);
    const completion =
      claim.kind === "complete"
        ? { kind: "linked" as const, scheduledTaskId: claim.scheduledTaskId }
        : await input.repository.completeGrantExpiryWarningClaim({
            grantId: identity.grantId,
            attemptToken,
            scheduledTaskId: task.taskId,
            warningAt: identity.warningAt,
            expiresAt: identity.expiresAt,
            completedAt: input.now.toISOString(),
          });
    if (completion.kind === "cancelled") {
      const cancelled = TERMINAL_TASK_STATES.has(task.state.status)
        ? task
        : await input.scheduledTasks.apply(task.taskId, "dismiss", {
            reason: "household grant revoked during warning creation",
          });
      return {
        outcome: "cancelled",
        grantId: identity.grantId,
        scheduledTaskId: cancelled.taskId,
        taskState: cancelled.state.status,
        autoExtend: false,
      };
    }
    const scheduledTaskId = completion.scheduledTaskId;
    if (scheduledTaskId !== task.taskId) {
      throw new HouseholdCoordinationError(
        "Household grant warning link points to a different ScheduledTask",
        "HOUSEHOLD_INVALID_CONTRACT",
        {
          grantId: identity.grantId,
          scheduledTaskId,
          taskId: task.taskId,
        },
      );
    }
    return {
      outcome: "ready",
      grantId: identity.grantId,
      scheduledTaskId,
      taskState: task.state.status,
      warningAt: identity.warningAt,
      expiresAt: identity.expiresAt,
      deduplicated,
      autoExtend: false,
    };
  } catch (error) {
    // error-policy:J2 context-adding rethrow — a failed materialization releases
    // only this claimant's lease so the durable intent can be retried at once.
    if (claim.kind === "claimed") {
      await input.repository.releaseGrantExpiryWarningClaim({
        grantId: identity.grantId,
        attemptToken,
        releasedAt: input.now.toISOString(),
      });
    }
    throw new HouseholdCoordinationError(
      "Household grant expiry warning could not be materialized",
      "HOUSEHOLD_INVALID_CONTRACT",
      {
        grantId: identity.grantId,
        warningAt: identity.warningAt,
        expiresAt: identity.expiresAt,
      },
      error,
    );
  }
}

export async function cancelHouseholdGrantExpiryWarning(input: {
  grant: HouseholdAccessGrant;
  repository: HouseholdCoordinationRepository;
  scheduledTasks: ScheduledTaskRunnerHandle;
  now: Date;
}): Promise<HouseholdGrantExpiryWarningReceipt> {
  const cancelledAt = input.now.toISOString();
  const taskId = await input.repository.markGrantExpiryWarningCancelled(
    input.grant.id,
    cancelledAt,
  );
  try {
    const tasks = await input.scheduledTasks.list({ kind: "watcher" });
    const expiresAt = input.grant.expiresAt;
    const unlinked = expiresAt
      ? tasks.filter(
          (candidate) =>
            candidate.idempotencyKey ===
            idempotencyKey(input.grant.id, expiresAt),
        )
      : [];
    if (unlinked.length > 1) {
      throw new HouseholdCoordinationError(
        "Multiple ScheduledTasks share one revoked household grant warning identity",
        "HOUSEHOLD_INVALID_CONTRACT",
        { grantId: input.grant.id },
      );
    }
    const task = taskId
      ? tasks.find((candidate) => candidate.taskId === taskId)
      : unlinked[0];
    if (!task && !taskId) {
      await input.repository.completeGrantExpiryWarningCancellation({
        grantId: input.grant.id,
        completedAt: cancelledAt,
      });
      return {
        outcome: "cancelled",
        grantId: input.grant.id,
        scheduledTaskId: null,
        taskState: "not_scheduled",
        autoExtend: false,
      };
    }
    if (!task) {
      throw new HouseholdCoordinationError(
        "Household grant warning link references a missing ScheduledTask",
        "HOUSEHOLD_INVALID_CONTRACT",
        { grantId: input.grant.id, taskId },
      );
    }
    const cancelled = TERMINAL_TASK_STATES.has(task.state.status)
      ? task
      : await input.scheduledTasks.apply(task.taskId, "dismiss", {
          reason: "household grant revoked",
        });
    await input.repository.completeGrantExpiryWarningCancellation({
      grantId: input.grant.id,
      completedAt: cancelledAt,
    });
    return {
      outcome: "cancelled",
      grantId: input.grant.id,
      scheduledTaskId: cancelled.taskId,
      taskState: cancelled.state.status,
      autoExtend: false,
    };
  } catch (error) {
    // error-policy:J2 context-adding rethrow — cancellation intent is already
    // committed; record the failed attempt so the shared scheduler can retry
    // without making the caller believe access revocation rolled back.
    try {
      await input.repository.recordGrantExpiryWarningCancellationFailure({
        grantId: input.grant.id,
        failedAt: cancelledAt,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (recordError) {
      // error-policy:J2 context-adding rethrow — losing both task dismissal and
      // its diagnostic update is a compound outbox failure.
      throw new HouseholdCoordinationError(
        "Household grant warning cancellation and failure recording both failed",
        "HOUSEHOLD_INVALID_CONTRACT",
        { grantId: input.grant.id },
        new AggregateError([error, recordError]),
      );
    }
    throw new HouseholdCoordinationError(
      "Household grant warning cancellation is pending retry",
      "HOUSEHOLD_INVALID_CONTRACT",
      { grantId: input.grant.id },
      error,
    );
  }
}

export function registerHouseholdGrantExpiryWarningGate(
  repository: HouseholdCoordinationRepository,
  gates: TaskGateRegistry,
): void {
  gates.register({
    kind: HOUSEHOLD_GRANT_EXPIRY_WARNING_GATE,
    async evaluate(task, context) {
      const identity = taskIdentity(task);
      assertTaskContract(task, identity);
      const persisted = await repository.getGrantExpiryWarning(
        identity.grantId,
      );
      if (
        !persisted ||
        persisted.scheduledTaskId !== task.taskId ||
        persisted.warningAt !== identity.warningAt ||
        persisted.expiresAt !== identity.expiresAt
      ) {
        throw new HouseholdCoordinationError(
          "Household grant warning does not match its durable scheduling claim",
          "HOUSEHOLD_INVALID_CONTRACT",
          {
            grantId: identity.grantId,
            taskId: task.taskId,
            persistedTaskId: persisted?.scheduledTaskId,
            persistedWarningAt: persisted?.warningAt,
            persistedExpiresAt: persisted?.expiresAt,
          },
        );
      }
      const grant = await repository.getGrant(identity.grantId);
      if (!grant) {
        throw new HouseholdCoordinationError(
          "Household grant warning references a missing grant",
          "HOUSEHOLD_INVALID_CONTRACT",
          { grantId: identity.grantId, taskId: task.taskId },
        );
      }
      const currentIdentity = identityFor(grant, new Date(grant.createdAt));
      if (!currentIdentity) {
        throw new HouseholdCoordinationError(
          "Household grant warning references a non-expiring grant",
          "HOUSEHOLD_INVALID_CONTRACT",
          { grantId: grant.id, taskId: task.taskId },
        );
      }
      const persistedIdentity = {
        ...currentIdentity,
        warningAt: persisted.warningAt,
      };
      if (JSON.stringify(persistedIdentity) !== JSON.stringify(identity)) {
        throw new HouseholdCoordinationError(
          "Household grant identity changed after its warning was scheduled",
          "HOUSEHOLD_INVALID_CONTRACT",
          { grantId: grant.id, taskId: task.taskId },
        );
      }
      if (grant.revokedAt) {
        return {
          kind: "deny",
          reason: "household_grant_preexpiry: grant revoked",
        };
      }
      const nowMs = Date.parse(context.nowIso);
      if (nowMs >= Date.parse(identity.expiresAt)) {
        return {
          kind: "deny",
          reason: "household_grant_preexpiry: grant expired",
        };
      }
      if (nowMs < Date.parse(identity.warningAt)) {
        return {
          kind: "defer",
          until: { atIso: identity.warningAt },
          reason: "household_grant_preexpiry: warning window not reached",
        };
      }
      return { kind: "allow" };
    },
  });
}
