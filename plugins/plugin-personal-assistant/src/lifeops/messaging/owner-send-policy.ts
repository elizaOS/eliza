import type {
  DraftRequest,
  IAgentRuntime,
  MessageSource,
  SendPolicy,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getConnectorRegistry } from "../connectors/registry.js";

/**
 * Stable task (and task-worker) name for owner send approvals. Core's
 * CHOOSE_OPTION action resolves the worker by the task's `name`, so every
 * approval task uses this one name and the worker dispatches on task
 * metadata (`actionName` + per-task executor) instead of a per-task name.
 */
export const OWNER_SEND_APPROVAL_TASK_NAME = "OWNER_SEND_APPROVAL";

type ApprovedSendExecutor = () => Promise<{ externalId: string }>;

/**
 * Held send executors, keyed per runtime and per approval-task id. The
 * executor is a closure over the in-memory triage draft
 * (`TriageService.sendDraft`) and cannot be persisted; if the process
 * restarts before the owner decides, the worker hard-fails so the owner
 * re-issues the send instead of believing it went out.
 */
const pendingExecutors = new WeakMap<
  IAgentRuntime,
  Map<string, ApprovedSendExecutor>
>();

function executorsFor(
  runtime: IAgentRuntime,
): Map<string, ApprovedSendExecutor> {
  let map = pendingExecutors.get(runtime);
  if (!map) {
    map = new Map();
    pendingExecutors.set(runtime, map);
  }
  return map;
}

/**
 * Register the single stable CHOOSE_OPTION task worker that executes (or
 * cancels) an owner-approved outbound send. Idempotent; called at plugin
 * init and defensively before every approval enqueue so an approval task
 * can never exist without its executing worker (issue #10723).
 */
export function registerOwnerSendApprovalWorker(runtime: IAgentRuntime): void {
  if (
    typeof runtime.registerTaskWorker !== "function" ||
    typeof runtime.getTaskWorker !== "function"
  ) {
    throw new Error(
      "[OwnerSendPolicy] runtime.registerTaskWorker is required for outbound approvals",
    );
  }
  if (runtime.getTaskWorker(OWNER_SEND_APPROVAL_TASK_NAME)) return;
  runtime.registerTaskWorker({
    name: OWNER_SEND_APPROVAL_TASK_NAME,
    execute: async (rt, options, task) => {
      if (!task.id) {
        throw new Error(
          "[OwnerSendPolicy] send-approval task is missing its id",
        );
      }
      const taskId = String(task.id);
      const option = typeof options.option === "string" ? options.option : "";
      if (option === "cancel") {
        executorsFor(rt).delete(taskId);
        await rt.deleteTask(task.id);
        logger.info(
          `[OwnerSendPolicy] owner cancelled send approval ${taskId}; nothing was sent`,
        );
        return undefined;
      }
      if (option !== "confirm") {
        throw new Error(
          `[OwnerSendPolicy] unknown option "${option}" for send approval ${taskId}; nothing was sent`,
        );
      }
      const actionName = task.metadata?.actionName;
      if (actionName !== OWNER_SEND_APPROVAL_TASK_NAME) {
        throw new Error(
          `[OwnerSendPolicy] refusing to execute send approval ${taskId}: unknown action ${JSON.stringify(actionName)}; nothing was sent`,
        );
      }
      const executor = executorsFor(rt).get(taskId);
      if (!executor) {
        // The executor closure over the triage draft does not survive a
        // restart. Delete the dead task and fail loudly — the owner must
        // re-issue the send.
        await rt.deleteTask(task.id);
        throw new Error(
          `[OwnerSendPolicy] approved send ${taskId} can no longer execute (draft executor lost, e.g. after a restart); nothing was sent — please re-send the draft`,
        );
      }
      const { externalId } = await executor();
      executorsFor(rt).delete(taskId);
      await rt.deleteTask(task.id);
      logger.info(
        `[OwnerSendPolicy] approved send ${taskId} executed (externalId=${externalId})`,
      );
      return undefined;
    },
  });
}

/**
 * Map a `MessageSource` (the triage-layer enum) to the corresponding
 * `ConnectorRegistry` kind. Gmail is a Google capability, not a separate
 * connector kind, so the source `"gmail"` resolves to connector `"google"`.
 *
 * Sources without a matching connector (e.g. `browser_bridge`) return `null`
 * and the default approval policy (no approval) applies.
 */
const SOURCE_TO_CONNECTOR_KIND: Partial<Record<MessageSource, string>> = {
  gmail: "google",
  discord: "discord",
  telegram: "telegram",
  twitter: "x",
  imessage: "imessage",
  signal: "signal",
  whatsapp: "whatsapp",
  calendly: "calendly",
};

function approvalRequiredForSource(
  runtime: IAgentRuntime,
  source: MessageSource,
): boolean {
  const kind = SOURCE_TO_CONNECTOR_KIND[source];
  if (!kind) return false;
  const registry = getConnectorRegistry(runtime);
  if (!registry) return false;
  return registry.get(kind)?.requiresApproval === true;
}

function makeApprovalDescription(draft: DraftRequest): string {
  const recipients = draft.to
    .map((entry) => entry.displayName ?? entry.identifier)
    .filter(Boolean)
    .join(", ");
  const subject = draft.subject ? ` (${draft.subject})` : "";
  const preview =
    draft.body.length > 240 ? `${draft.body.slice(0, 237)}...` : draft.body;
  const target = recipients.length > 0 ? recipients : "(no recipients)";
  return `Approve sending ${draft.source} to ${target}${subject}: ${preview}`;
}

function previewDraft(draft: DraftRequest): string {
  if (draft.body.length <= 200) return draft.body;
  return `${draft.body.slice(0, 197)}...`;
}

export function createOwnerSendPolicy(): SendPolicy {
  return {
    async shouldRequireApproval(runtime, draft) {
      return approvalRequiredForSource(runtime, draft.source);
    },
    async enqueueApproval(runtime, draft, executor) {
      if (typeof runtime.createTask !== "function") {
        throw new Error(
          "[OwnerSendPolicy] runtime.createTask is required for outbound approvals",
        );
      }
      registerOwnerSendApprovalWorker(runtime);
      const requestId = await runtime.createTask({
        name: OWNER_SEND_APPROVAL_TASK_NAME,
        description: makeApprovalDescription(draft),
        roomId:
          (draft.metadata?.roomId as string | undefined) ?? runtime.agentId,
        entityId:
          (draft.metadata?.entityId as string | undefined) ?? runtime.agentId,
        tags: ["AWAITING_CHOICE", "APPROVAL", OWNER_SEND_APPROVAL_TASK_NAME],
        metadata: {
          options: [
            { name: "confirm", description: "Send the drafted message" },
            { name: "cancel", description: "Do not send it" },
          ],
          approvalRequest: {
            timeoutMs: 24 * 60 * 60 * 1000,
            timeoutDefault: "cancel",
            createdAt: Date.now(),
            isAsync: true,
          },
          actionName: OWNER_SEND_APPROVAL_TASK_NAME,
          source: draft.source,
          payload: {
            source: draft.source,
            inReplyToId: draft.inReplyToId ?? null,
            threadId: draft.threadId ?? null,
            to: draft.to,
            subject: draft.subject ?? null,
            body: draft.body,
            worldId: draft.worldId ?? null,
            channelId: draft.channelId ?? null,
          },
        },
      });
      // The stable OWNER_SEND_APPROVAL task worker looks the executor up by
      // task id when core's CHOOSE_OPTION routes the owner's confirm/cancel
      // selection here.
      executorsFor(runtime).set(String(requestId), executor);
      return {
        requestId: String(requestId),
        preview: previewDraft(draft),
      };
    },
  };
}
