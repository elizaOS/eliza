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
import { Hono } from "hono";
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
  personalDedicatedAgentApiBase,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import {
  commitSharedReminderCutover,
  releaseSharedReminderCutover,
  reserveSharedRemindersForCutover,
  SHARED_CUTOVER_GATEWAY_CHANNEL,
  SharedReminderCutoverConflictError,
} from "@/lib/services/shared-runtime/shared-scheduling";
import { readSharedTodoCutoverState } from "@/lib/services/shared-runtime/shared-todos";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";
const CUTOVER_SEAL_LEASE_MS = 60_000;
const bodySchema = z.object({ dedicatedAgentId: z.string().uuid() });

function json(body: unknown, status = 200): Response {
  return applyCorsHeaders(Response.json(body, { status }), CORS_METHODS);
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
  authorization: string | undefined,
  apiKey: string | undefined,
): Promise<{ response: Response; receipt: Record<string, unknown> | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
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
      return json(
        {
          success: false,
          code: "invalid_dedicated_cutover",
          error: "A valid Dedicated target id is required.",
        },
        400,
      );
    }

    const sourceAgentId = personalSharedAgentId({
      userId: user.id,
      organizationId: user.organization_id,
    });
    if (c.req.param("agentId") !== sourceAgentId) {
      return json({ success: false, error: "Agent not found" }, 404);
    }
    const conversationNamespace = c.env.SHARED_RUNTIME_CONVERSATIONS;
    if (
      !conversationNamespace ||
      typeof conversationNamespace.getByName !== "function"
    ) {
      return json(
        {
          success: false,
          code: "shared_history_unavailable",
          error:
            "Shared history is temporarily unavailable. Shared remains active.",
        },
        503,
      );
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
      return json(
        {
          success: false,
          code: "personal_identity_convergence_in_progress",
          error:
            "Personal history is still linking across channels. Try Dedicated activation again shortly.",
        },
        409,
      );
    }
    const sealToken = `personal-cutover:${sourceAgentId}:${parsed.data.dedicatedAgentId}`;
    const reminderReservationToken = `${sealToken}:reminders:${crypto.randomUUID()}`;
    const authorization = c.req.header("authorization");
    const apiKey = c.req.header("x-api-key");
    const active = await findActivePersonalDedicatedTarget(
      user.organization_id,
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
            authorization,
            apiKey,
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
          return json({
            success: true,
            data: {
              personalElizaId: sourceAgentId,
              activeAgentId: active.id,
              runtime: "dedicated" as const,
              apiBase: activeBase,
              importedMessages: marker.sharedMessageCount,
              importedScheduledTasks: marker.sharedScheduledTaskCount,
              importedTodos: marker.sharedTodoCount,
              importedTodoMutations: marker.sharedTodoMutationCount,
            },
          });
        } catch {
          // error-policy:J4 An old or interrupted marker is not accepted as a
          // healthy success until the full sealed import below repairs it.
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
      return json(
        {
          success: false,
          code: "dedicated_not_healthy",
          error:
            "Dedicated is not healthy yet. Shared remains active; try again when setup finishes.",
        },
        409,
      );
    }

    const base = personalDedicatedAgentApiBase(
      target,
      c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    );
    if (!base) {
      return json(
        {
          success: false,
          code: "dedicated_not_reachable",
          error:
            "Dedicated has no reachable endpoint yet. Shared remains active.",
        },
        409,
      );
    }
    const history = await coordinateSharedCutoverSeal(
      sourceAgentId,
      sourceAgentId,
      {
        token: sealToken,
        leaseMs: CUTOVER_SEAL_LEASE_MS,
        organizationId: user.organization_id,
        dedicatedAgentId: target.id,
      },
      { namespace: conversationNamespace },
    );
    let markerCommitted = false;
    let remindersReserved = false;
    try {
      if (history.some((message) => !message.id)) {
        return json(
          {
            success: false,
            code: "shared_history_identity_missing",
            error:
              "Shared history could not be verified for an exact transfer. Shared remains active.",
          },
          503,
        );
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
          return json(
            {
              success: false,
              code: "personal_reminder_cutover_in_progress",
              error:
                "Another Dedicated cutover is already moving Shared reminders.",
            },
            423,
          );
        }
        throw error;
      }
      const importUrl = `${base}/api/conversations/${encodeURIComponent(sourceAgentId)}/import`;
      let todoSnapshot = await readTodoCutoverSnapshot(sourceAgentId, user.id);
      const importedMessages = history.map((message) => ({
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
          authorization,
          apiKey,
        );
        if (!imported.response.ok) {
          return json(
            {
              success: false,
              code: "dedicated_history_import_failed",
              error:
                "History, reminders, and Todos did not finish moving to Dedicated. Shared remains active.",
            },
            503,
          );
        }
        const receipt = imported.receipt;
        if (
          !confirmsPersonalImport(
            receipt,
            history.length,
            scheduledTasks.length,
            todoSnapshot,
            false,
          )
        ) {
          return json(
            {
              success: false,
              code: "dedicated_history_receipt_invalid",
              error:
                "Dedicated did not confirm the complete history, reminder, and Todo import. Shared remains active.",
            },
            503,
          );
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
          return json(
            {
              success: false,
              code: "shared_personal_snapshot_unstable",
              error:
                "Shared personal data is still settling. Try Dedicated activation again.",
            },
            409,
          );
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
        sharedMessageCount: history.length,
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
        authorization,
        apiKey,
      );
      if (
        !activation.response.ok ||
        !confirmsPersonalImport(
          activation.receipt,
          history.length,
          scheduledTasks.length,
          todoSnapshot,
          true,
        )
      ) {
        return json(
          {
            success: false,
            code: "dedicated_reminder_activation_failed",
            error:
              "Dedicated did not confirm the imported reminders and Todos. Retry cutover to repair them.",
          },
          503,
        );
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
          apiBase: base,
          importedMessages: history.length,
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
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
});

export default app;
