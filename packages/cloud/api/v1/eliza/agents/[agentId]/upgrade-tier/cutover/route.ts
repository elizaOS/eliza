/**
 * Finalizes one personal Shared→Dedicated activation. The server re-imports
 * the authoritative Shared history into the healthy target before atomically
 * marking that target active, so phone and future app sessions cannot switch
 * early or lose the working Shared fallback on failure.
 */

import {
  createSharedTodoCutoverSnapshot,
  type SharedTodoCutoverSnapshot,
} from "@elizaos/shared/todo-cutover";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { usersRepository } from "@/db/repositories/users";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  finalizePersonalTierUpgradeCutover,
  findActivePersonalDedicatedTarget,
  findLiveTierUpgradeTarget,
} from "@/lib/services/agent-tier-upgrade-target";
import { readPersonalElizaCutover } from "@/lib/services/eliza-agent-config";
import { invalidatePersonalDeliveryProjection } from "@/lib/services/eliza-app/personal-delivery-projection-contract";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  coordinateSharedCutoverCommit,
  coordinateSharedCutoverRelease,
  coordinateSharedCutoverSeal,
} from "@/lib/services/shared-runtime/conversation-coordinator";
import {
  dedicatedAgentTransportToken,
  personalDedicatedAgentApiBase,
  personalDedicatedClientApiBase,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import { SharedRuntimeCacheWarmingError } from "@/lib/services/shared-runtime/shared-runtime-errors";
import {
  commitSharedReminderCutover,
  releaseSharedReminderCutover,
  reserveSharedRemindersForCutover,
  SHARED_CUTOVER_GATEWAY_CHANNEL,
  SharedReminderCutoverConflictError,
} from "@/lib/services/shared-runtime/shared-scheduling";
import { readSharedTodoCutoverState } from "@/lib/services/shared-runtime/shared-todos";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";
const CUTOVER_SEAL_LEASE_MS = 60_000;
const bodySchema = z.object({ dedicatedAgentId: z.string().uuid() });

function json(body: unknown, status = 200): Response {
  return applyCorsHeaders(Response.json(body, { status }), CORS_METHODS);
}

interface CutoverRejection {
  code: string;
  error: string;
  status: number;
  phase: string;
  context?: Record<string, unknown>;
}

function rejectCutover(
  c: Context<AppEnv>,
  rejection: CutoverRejection,
): Response {
  logger.warn("[personal-dedicated-cutover] Cutover rejected", {
    traceId: c.get("traceId") ?? c.get("requestId"),
    code: rejection.code,
    status: rejection.status,
    phase: rejection.phase,
    sourceAgentId: c.req.param("agentId") ?? null,
    ...rejection.context,
  });
  return json(
    {
      success: false,
      code: rejection.code,
      error: rejection.error,
    },
    rejection.status,
  );
}

function errorDiagnostic(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  return {
    errorName: error.name,
    errorMessage: error.message,
    errorStack: error.stack,
    errorCause:
      error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message }
        : error.cause === undefined
          ? undefined
          : String(error.cause),
  };
}

async function invalidateUserDeliveryProjections(
  env: AppEnv["Bindings"],
  user: {
    telegram_id?: string | null;
    discord_id?: string | null;
    phone_number?: string | null;
  },
): Promise<void> {
  await Promise.all([
    invalidatePersonalDeliveryProjection(
      env.PERSONAL_DELIVERY_PROJECTIONS,
      "telegram",
      user.telegram_id,
    ),
    invalidatePersonalDeliveryProjection(
      env.PERSONAL_DELIVERY_PROJECTIONS,
      "discord",
      user.discord_id,
    ),
    invalidatePersonalDeliveryProjection(
      env.PERSONAL_DELIVERY_PROJECTIONS,
      "phone",
      user.phone_number,
    ),
  ]);
}

function prepareRemindersForDedicated(
  tasks: Awaited<ReturnType<typeof reserveSharedRemindersForCutover>>,
) {
  return tasks.map((task) => ({
    ...task,
    escalation: {
      ...(task.escalation ?? {}),
      steps: (
        task.escalation?.steps ?? [
          { delayMinutes: 0, channelKey: SHARED_CUTOVER_GATEWAY_CHANNEL },
        ]
      ).map((step) => ({
        ...step,
        channelKey: SHARED_CUTOVER_GATEWAY_CHANNEL,
      })),
    },
    output: task.output
      ? { ...task.output, target: SHARED_CUTOVER_GATEWAY_CHANNEL }
      : task.output,
  }));
}

function scheduledTaskSnapshotsMatch(
  left: Awaited<ReturnType<typeof reserveSharedRemindersForCutover>>,
  right: Awaited<ReturnType<typeof reserveSharedRemindersForCutover>>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (task, index) => JSON.stringify(task) === JSON.stringify(right[index]),
    )
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    // error-policy:J3 malformed transport input is returned to the caller as
    // an explicit validation failure, never treated as a valid empty payload.
    return null;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // error-policy:J3 an unreadable import receipt is an explicit failed
    // cutover; Shared stays sealed only for this request's bounded lease.
    return null;
  }
}

async function postDedicatedImport(
  url: string,
  body: Record<string, unknown>,
  agentToken: string,
): Promise<{ response: Response; receipt: Record<string, unknown> | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${agentToken}`,
      "X-API-Key": agentToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = await readJsonResponse(response);
  return {
    response,
    receipt:
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null,
  };
}

async function readTodoCutoverSnapshot(
  sourceAgentId: string,
  ownerId: string,
): Promise<SharedTodoCutoverSnapshot> {
  const state = await readSharedTodoCutoverState({ sourceAgentId, ownerId });
  return createSharedTodoCutoverSnapshot({
    sourceAgentId,
    todos: state.todos.map((todo) => ({
      sourceId: todo.id,
      roomId: todo.roomId,
      worldId: todo.worldId,
      content: todo.content,
      activeForm: todo.activeForm,
      status: todo.status,
      parentSourceId: todo.parentTodoId,
      parentTrajectoryStepId: todo.parentTrajectoryStepId,
      metadata: todo.metadata,
      createdAt: todo.createdAt.toISOString(),
      updatedAt: todo.updatedAt.toISOString(),
      completedAt: todo.completedAt?.toISOString() ?? null,
    })),
    mutations: state.mutations,
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function confirmsTodoImport(
  receipt: Record<string, unknown> | null,
  snapshot: SharedTodoCutoverSnapshot,
): boolean {
  return (
    receipt?.sourceTodoCount === snapshot.todos.length &&
    receipt.sourceTodoMutationCount === snapshot.mutations.length &&
    isNonNegativeSafeInteger(receipt.importedTodos) &&
    isNonNegativeSafeInteger(receipt.repairedTodos) &&
    isNonNegativeSafeInteger(receipt.skippedTodos) &&
    isNonNegativeSafeInteger(receipt.removedStaleTodos) &&
    receipt.importedTodos + receipt.repairedTodos + receipt.skippedTodos ===
      snapshot.todos.length &&
    isNonNegativeSafeInteger(receipt.importedTodoMutations) &&
    isNonNegativeSafeInteger(receipt.skippedTodoMutations) &&
    receipt.importedTodoMutations + receipt.skippedTodoMutations ===
      snapshot.mutations.length &&
    receipt.sourceTodoDigest === snapshot.digest &&
    receipt.targetTodoDigest === snapshot.digest
  );
}

function confirmsPersonalImport(
  receipt: Record<string, unknown> | null,
  expectedMessageCount: number,
  expectedScheduledTaskCount: number,
  todoSnapshot: SharedTodoCutoverSnapshot,
  requireActivation: boolean,
): boolean {
  if (
    receipt?.complete !== true ||
    receipt.sourceMessageCount !== expectedMessageCount ||
    !isNonNegativeSafeInteger(receipt.inserted) ||
    !isNonNegativeSafeInteger(receipt.skipped) ||
    receipt.inserted + receipt.skipped !== expectedMessageCount ||
    receipt.sourceScheduledTaskCount !== expectedScheduledTaskCount ||
    !isNonNegativeSafeInteger(receipt.importedScheduledTasks) ||
    !isNonNegativeSafeInteger(receipt.skippedScheduledTasks) ||
    receipt.importedScheduledTasks + receipt.skippedScheduledTasks !==
      expectedScheduledTaskCount ||
    !confirmsTodoImport(receipt, todoSnapshot)
  ) {
    return false;
  }
  if (!requireActivation) return true;
  return (
    isNonNegativeSafeInteger(receipt.activatedScheduledTasks) &&
    isNonNegativeSafeInteger(receipt.skippedActivatedScheduledTasks) &&
    receipt.activatedScheduledTasks + receipt.skippedActivatedScheduledTasks ===
      expectedScheduledTaskCount
  );
}

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.post("/", async (c) => {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(c.req.raw);
    const parsed = bodySchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success) {
      return rejectCutover(c, {
        code: "invalid_dedicated_cutover",
        error: "A valid Dedicated target id is required.",
        status: 400,
        phase: "validate-request",
        context: { orgId: user.organization_id, userId: user.id },
      });
    }

    const sourceAgentId = personalSharedAgentId({
      userId: user.id,
      organizationId: user.organization_id,
    });
    if (c.req.param("agentId") !== sourceAgentId) {
      return rejectCutover(c, {
        code: "personal_source_not_found",
        error: "Agent not found",
        status: 404,
        phase: "authorize-source",
        context: { orgId: user.organization_id, userId: user.id },
      });
    }
    const conversationNamespace = c.env.SHARED_RUNTIME_CONVERSATIONS;
    if (
      !conversationNamespace ||
      typeof conversationNamespace.getByName !== "function"
    ) {
      return rejectCutover(c, {
        code: "shared_history_unavailable",
        error:
          "Shared history is temporarily unavailable. Shared remains active.",
        status: 503,
        phase: "resolve-shared-history",
        context: { orgId: user.organization_id, userId: user.id },
      });
    }
    if (
      await usersRepository.hasPendingPhoneTelegramPersonalAccountConvergenceTarget(
        {
          targetUserId: user.id,
          targetOrganizationId: user.organization_id,
          targetAgentId: sourceAgentId,
        },
      )
    ) {
      return rejectCutover(c, {
        code: "personal_identity_convergence_in_progress",
        error:
          "Personal history is still linking across channels. Try Dedicated activation again shortly.",
        status: 409,
        phase: "identity-convergence",
        context: { orgId: user.organization_id, userId: user.id },
      });
    }
    const sealToken = `personal-cutover:${sourceAgentId}:${parsed.data.dedicatedAgentId}`;
    const reminderReservationToken = `${sealToken}:reminders:${crypto.randomUUID()}`;
    const active = await findActivePersonalDedicatedTarget(
      user.organization_id,
      user.id,
      sourceAgentId,
    );
    if (
      active?.id === parsed.data.dedicatedAgentId &&
      active.user_id === user.id
    ) {
      const marker = readPersonalElizaCutover(
        active.agent_config as Record<string, unknown> | null,
      );
      const activeBase = personalDedicatedAgentApiBase(
        active,
        c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
      );
      const activeTodoSnapshot = await readTodoCutoverSnapshot(
        sourceAgentId,
        user.id,
      );
      if (
        marker?.cutoverToken === sealToken &&
        marker.sharedTodoCount === activeTodoSnapshot.todos.length &&
        marker.sharedTodoMutationCount ===
          activeTodoSnapshot.mutations.length &&
        marker.sharedTodoDigest === activeTodoSnapshot.digest &&
        activeBase
      ) {
        const activeToken = dedicatedAgentTransportToken(active);
        if (!activeToken) {
          return rejectCutover(c, {
            code: "dedicated_transport_unavailable",
            error:
              "Dedicated authentication is still being prepared. Shared remains active.",
            status: 503,
            phase: "repair-active-transport",
            context: {
              orgId: user.organization_id,
              userId: user.id,
              dedicatedAgentId: active.id,
              targetStatus: active.status,
            },
          });
        }
        try {
          await invalidateUserDeliveryProjections(c.env, user);
          await coordinateSharedCutoverCommit(
            sourceAgentId,
            sourceAgentId,
            sealToken,
            { namespace: conversationNamespace },
          );
          const scheduledTasks = await reserveSharedRemindersForCutover({
            sourceAgentId,
            targetAgentId: active.id,
            token: sealToken,
            holderToken: reminderReservationToken,
            authoritative: true,
          });
          const activation = await postDedicatedImport(
            `${activeBase}/api/conversations/${encodeURIComponent(sourceAgentId)}/import`,
            {
              messages: [],
              scheduledTasks: prepareRemindersForDedicated(scheduledTasks),
              todoSnapshot: activeTodoSnapshot,
              cutoverToken: sealToken,
              activateScheduledTasks: true,
            },
            activeToken,
          );
          if (
            !activation.response.ok ||
            !confirmsPersonalImport(
              activation.receipt,
              0,
              scheduledTasks.length,
              activeTodoSnapshot,
              true,
            )
          ) {
            throw new Error(
              "Dedicated did not confirm personal-data activation for the committed cutover",
            );
          }
          await commitSharedReminderCutover({
            sourceAgentId,
            targetAgentId: active.id,
            token: sealToken,
            holderToken: reminderReservationToken,
            expectedTaskCount: marker.sharedScheduledTaskCount,
          });
          await finalizePersonalTierUpgradeCutover({
            organizationId: user.organization_id,
            userId: user.id,
            sourceAgentId,
            dedicatedAgentId: active.id,
            cutoverToken: marker.cutoverToken,
            sharedMessageCount: marker.sharedMessageCount,
            sharedScheduledTaskCount: marker.sharedScheduledTaskCount,
            sharedTodoCount: marker.sharedTodoCount,
            sharedTodoMutationCount: marker.sharedTodoMutationCount,
            sharedTodoDigest: marker.sharedTodoDigest,
          });
          return json({
            success: true,
            data: {
              personalElizaId: sourceAgentId,
              activeAgentId: active.id,
              runtime: "dedicated" as const,
              apiBase:
                personalDedicatedClientApiBase(
                  active,
                  c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
                  new URL(c.req.url).origin,
                ) ?? activeBase,
              importedMessages: marker.sharedMessageCount,
              importedScheduledTasks: marker.sharedScheduledTaskCount,
              importedTodos: marker.sharedTodoCount,
              importedTodoMutations: marker.sharedTodoMutationCount,
            },
          });
        } catch (error) {
          // error-policy:J4 An old or interrupted marker is not accepted as a
          // healthy success until the full sealed import below repairs it.
          logger.warn(
            "[personal-dedicated-cutover] Active marker repair failed; full sealed import retained",
            {
              traceId: c.get("traceId") ?? c.get("requestId"),
              phase: "repair-active-marker",
              sourceAgentId,
              dedicatedAgentId: active.id,
              orgId: user.organization_id,
              userId: user.id,
              ...errorDiagnostic(error),
            },
          );
        }
      }
    }
    const target = await findLiveTierUpgradeTarget(
      user.organization_id,
      sourceAgentId,
    );
    if (
      !target ||
      target.id !== parsed.data.dedicatedAgentId ||
      target.user_id !== user.id ||
      target.status !== "running"
    ) {
      return rejectCutover(c, {
        code: "dedicated_not_healthy",
        error:
          "Dedicated is not healthy yet. Shared remains active; try again when setup finishes.",
        status: 409,
        phase: "resolve-running-target",
        context: {
          orgId: user.organization_id,
          userId: user.id,
          requestedDedicatedAgentId: parsed.data.dedicatedAgentId,
          targetResolved: Boolean(target),
          targetIdMatches: target?.id === parsed.data.dedicatedAgentId,
          targetOwnerMatches: target?.user_id === user.id,
          targetStatus: target?.status ?? null,
          targetLifecycleRevision: target?.lifecycle_revision ?? null,
        },
      });
    }

    const base = personalDedicatedAgentApiBase(
      target,
      c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    );
    if (!base) {
      return rejectCutover(c, {
        code: "dedicated_not_reachable",
        error:
          "Dedicated has no reachable endpoint yet. Shared remains active.",
        status: 409,
        phase: "resolve-dedicated-endpoint",
        context: {
          orgId: user.organization_id,
          userId: user.id,
          dedicatedAgentId: target.id,
          targetStatus: target.status,
        },
      });
    }
    const targetToken = dedicatedAgentTransportToken(target);
    if (!targetToken) {
      return rejectCutover(c, {
        code: "dedicated_transport_unavailable",
        error:
          "Dedicated authentication is still being prepared. Shared remains active.",
        status: 503,
        phase: "resolve-dedicated-transport",
        context: {
          orgId: user.organization_id,
          userId: user.id,
          dedicatedAgentId: target.id,
          targetStatus: target.status,
        },
      });
    }
    const history = await coordinateSharedCutoverSeal(
      sourceAgentId,
      sourceAgentId,
      {
        token: sealToken,
        leaseMs: CUTOVER_SEAL_LEASE_MS,
        organizationId: user.organization_id,
        userId: user.id,
        dedicatedAgentId: target.id,
      },
      { namespace: conversationNamespace },
    );
    let markerCommitted = false;
    let remindersReserved = false;
    try {
      // Lifecycle system turns remain in Shared's model history, but they are
      // not authored chat messages and the Dedicated import boundary rejects
      // caller-supplied system authority. Count and transfer only the same
      // user/assistant transcript that the Dedicated receipt can attest.
      const transferableHistory = history.filter(
        (message): message is typeof message & { role: "user" | "assistant" } =>
          message.role === "user" || message.role === "assistant",
      );
      if (transferableHistory.some((message) => !message.id)) {
        return rejectCutover(c, {
          code: "shared_history_identity_missing",
          error:
            "Shared history could not be verified for an exact transfer. Shared remains active.",
          status: 503,
          phase: "validate-shared-history",
          context: {
            orgId: user.organization_id,
            userId: user.id,
            dedicatedAgentId: target.id,
            transferableMessageCount: transferableHistory.length,
          },
        });
      }
      let scheduledTasks: Awaited<
        ReturnType<typeof reserveSharedRemindersForCutover>
      >;
      try {
        scheduledTasks = await reserveSharedRemindersForCutover({
          sourceAgentId,
          targetAgentId: target.id,
          token: sealToken,
          holderToken: reminderReservationToken,
        });
        remindersReserved = true;
      } catch (error) {
        // error-policy:J1 the cutover boundary translates an ownership conflict for retry.
        if (error instanceof SharedReminderCutoverConflictError) {
          return rejectCutover(c, {
            code: "personal_reminder_cutover_in_progress",
            error:
              "Another Dedicated cutover is already moving Shared reminders.",
            status: 423,
            phase: "reserve-shared-reminders",
            context: {
              orgId: user.organization_id,
              userId: user.id,
              dedicatedAgentId: target.id,
              ...errorDiagnostic(error),
            },
          });
        }
        throw error;
      }
      const importUrl = `${base}/api/conversations/${encodeURIComponent(sourceAgentId)}/import`;
      let todoSnapshot = await readTodoCutoverSnapshot(sourceAgentId, user.id);
      const importedMessages = transferableHistory.map((message) => ({
        sourceId: message.id,
        role: message.role,
        text: message.content,
        ...(typeof message.createdAt === "number"
          ? { timestamp: message.createdAt }
          : {}),
      }));
      for (let attempt = 0; ; attempt += 1) {
        const imported = await postDedicatedImport(
          importUrl,
          {
            messages: importedMessages,
            scheduledTasks: prepareRemindersForDedicated(scheduledTasks),
            todoSnapshot,
            cutoverToken: sealToken,
          },
          targetToken,
        );
        if (!imported.response.ok) {
          return rejectCutover(c, {
            code: "dedicated_history_import_failed",
            error:
              "History, reminders, and Todos did not finish moving to Dedicated. Shared remains active.",
            status: 503,
            phase: "import-personal-state",
            context: {
              orgId: user.organization_id,
              userId: user.id,
              dedicatedAgentId: target.id,
              upstreamStatus: imported.response.status,
              importAttempt: attempt + 1,
              messageCount: importedMessages.length,
              scheduledTaskCount: scheduledTasks.length,
              todoCount: todoSnapshot.todos.length,
              todoMutationCount: todoSnapshot.mutations.length,
            },
          });
        }
        const receipt = imported.receipt;
        if (
          !confirmsPersonalImport(
            receipt,
            importedMessages.length,
            scheduledTasks.length,
            todoSnapshot,
            false,
          )
        ) {
          return rejectCutover(c, {
            code: "dedicated_history_receipt_invalid",
            error:
              "Dedicated did not confirm the complete history, reminder, and Todo import. Shared remains active.",
            status: 503,
            phase: "verify-personal-import-receipt",
            context: {
              orgId: user.organization_id,
              userId: user.id,
              dedicatedAgentId: target.id,
              importAttempt: attempt + 1,
              upstreamStatus: imported.response.status,
              receiptPresent: Boolean(receipt),
              messageCount: importedMessages.length,
              scheduledTaskCount: scheduledTasks.length,
              todoCount: todoSnapshot.todos.length,
              todoMutationCount: todoSnapshot.mutations.length,
            },
          });
        }
        const refreshedTasks = await reserveSharedRemindersForCutover({
          sourceAgentId,
          targetAgentId: target.id,
          token: sealToken,
          holderToken: reminderReservationToken,
        });
        const refreshedTodoSnapshot = await readTodoCutoverSnapshot(
          sourceAgentId,
          user.id,
        );
        if (
          scheduledTaskSnapshotsMatch(refreshedTasks, scheduledTasks) &&
          refreshedTodoSnapshot.digest === todoSnapshot.digest
        ) {
          break;
        }
        if (attempt >= 2) {
          return rejectCutover(c, {
            code: "shared_personal_snapshot_unstable",
            error:
              "Shared personal data is still settling. Try Dedicated activation again.",
            status: 409,
            phase: "stabilize-personal-snapshot",
            context: {
              orgId: user.organization_id,
              userId: user.id,
              dedicatedAgentId: target.id,
              importAttempts: attempt + 1,
            },
          });
        }
        scheduledTasks = refreshedTasks;
        todoSnapshot = refreshedTodoSnapshot;
      }

      const activeTarget = await finalizePersonalTierUpgradeCutover({
        organizationId: user.organization_id,
        userId: user.id,
        sourceAgentId,
        dedicatedAgentId: target.id,
        cutoverToken: sealToken,
        sharedMessageCount: importedMessages.length,
        sharedScheduledTaskCount: scheduledTasks.length,
        sharedTodoCount: todoSnapshot.todos.length,
        sharedTodoMutationCount: todoSnapshot.mutations.length,
        sharedTodoDigest: todoSnapshot.digest,
      });
      markerCommitted = true;
      await invalidateUserDeliveryProjections(c.env, user);
      await coordinateSharedCutoverCommit(
        sourceAgentId,
        sourceAgentId,
        sealToken,
        { namespace: conversationNamespace },
      );
      const activation = await postDedicatedImport(
        importUrl,
        {
          messages: importedMessages,
          scheduledTasks: prepareRemindersForDedicated(scheduledTasks),
          todoSnapshot,
          cutoverToken: sealToken,
          activateScheduledTasks: true,
        },
        targetToken,
      );
      if (
        !activation.response.ok ||
        !confirmsPersonalImport(
          activation.receipt,
          importedMessages.length,
          scheduledTasks.length,
          todoSnapshot,
          true,
        )
      ) {
        return rejectCutover(c, {
          code: "dedicated_reminder_activation_failed",
          error:
            "Dedicated did not confirm the imported reminders and Todos. Retry cutover to repair them.",
          status: 503,
          phase: "activate-dedicated-personal-state",
          context: {
            orgId: user.organization_id,
            userId: user.id,
            dedicatedAgentId: target.id,
            upstreamStatus: activation.response.status,
            receiptPresent: Boolean(activation.receipt),
            messageCount: importedMessages.length,
            scheduledTaskCount: scheduledTasks.length,
            todoCount: todoSnapshot.todos.length,
            todoMutationCount: todoSnapshot.mutations.length,
          },
        });
      }
      await commitSharedReminderCutover({
        sourceAgentId,
        targetAgentId: target.id,
        token: sealToken,
        holderToken: reminderReservationToken,
        expectedTaskCount: scheduledTasks.length,
      });
      return json({
        success: true,
        data: {
          personalElizaId: sourceAgentId,
          activeAgentId: activeTarget.id,
          runtime: "dedicated" as const,
          apiBase:
            personalDedicatedClientApiBase(
              activeTarget,
              c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
              new URL(c.req.url).origin,
            ) ?? base,
          importedMessages: importedMessages.length,
          importedScheduledTasks: scheduledTasks.length,
          importedTodos: todoSnapshot.todos.length,
          importedTodoMutations: todoSnapshot.mutations.length,
        },
      });
    } finally {
      if (!markerCommitted) {
        if (remindersReserved) {
          await releaseSharedReminderCutover({
            sourceAgentId,
            targetAgentId: target.id,
            token: sealToken,
            holderToken: reminderReservationToken,
          });
        }
        await coordinateSharedCutoverRelease(
          sourceAgentId,
          sourceAgentId,
          sealToken,
          { namespace: conversationNamespace },
        );
      }
    }
  } catch (error) {
    // error-policy:J1 preserve the coordinator's temporary unavailable state
    // so the client can retry the idempotent cutover within its startup deadline.
    if (error instanceof SharedRuntimeCacheWarmingError) {
      return rejectCutover(c, {
        code: "shared_history_unavailable",
        error:
          "Shared history is temporarily unavailable. Retry Dedicated activation shortly.",
        status: 503,
        phase: "coordinate-shared-history",
      });
    }
    logger.error("[personal-dedicated-cutover] Cutover failed", {
      traceId: c.get("traceId") ?? c.get("requestId"),
      phase: "unhandled-boundary",
      sourceAgentId: c.req.param("agentId") ?? null,
      ...errorDiagnostic(error),
    });
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
});

export default app;
