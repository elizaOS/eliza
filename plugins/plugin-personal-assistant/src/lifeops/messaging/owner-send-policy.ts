// Applies owner messaging policy before connector dispatch.
import type {
  DraftRecord,
  DraftRequest,
  IAgentRuntime,
  MessageSource,
  SendPolicy,
} from "@elizaos/core";
import { getDefaultTriageService, logger } from "@elizaos/core";
import { getConnectorRegistry } from "../connectors/registry.js";

/**
 * Stable task (and task-worker) name for owner send approvals. Core's
 * CHOOSE_OPTION action resolves the worker by the task's `name`, so every
 * approval task uses this one name and the worker dispatches on task
 * metadata (`actionName` + the persisted draft payload) instead of a
 * per-task name.
 */
export const OWNER_SEND_APPROVAL_TASK_NAME = "OWNER_SEND_APPROVAL";

/**
 * Task ids with a confirm currently executing in this process. The claim is
 * a synchronous check+add before any await — atomic on the single-threaded
 * event loop — so a concurrent duplicate confirm for the same task fails
 * instead of double-sending (issue #11090). Restart safety does not depend
 * on this set: execution state lives in the persisted task row.
 */
const executingConfirms = new WeakMap<IAgentRuntime, Set<string>>();

function claimsFor(runtime: IAgentRuntime): Set<string> {
  let set = executingConfirms.get(runtime);
  if (!set) {
    set = new Set();
    executingConfirms.set(runtime, set);
  }
  return set;
}

/**
 * Exhaustive `MessageSource` membership guard. Core's node entry does not
 * re-export `ALL_MESSAGE_SOURCES`, so membership is pinned locally with a
 * `Record<MessageSource, true>` — the compiler fails this file whenever core
 * adds or removes a source, forcing this boundary to stay in sync.
 */
const MESSAGE_SOURCE_GUARD: Record<MessageSource, true> = {
  gmail: true,
  discord: true,
  telegram: true,
  twitter: true,
  imessage: true,
  signal: true,
  whatsapp: true,
  calendly: true,
  browser_bridge: true,
};

function isMessageSource(value: unknown): value is MessageSource {
  return (
    typeof value === "string" && Object.hasOwn(MESSAGE_SOURCE_GUARD, value)
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRecipients(
  value: unknown,
): Array<{ identifier: string; displayName?: string }> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Array<{ identifier: string; displayName?: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const identifier = (entry as { identifier?: unknown }).identifier;
    if (typeof identifier !== "string" || identifier.length === 0) return null;
    const displayName = (entry as { displayName?: unknown }).displayName;
    out.push({
      identifier,
      ...(typeof displayName === "string" ? { displayName } : {}),
    });
  }
  return out;
}

/**
 * Validate the persisted draft payload at the runtime boundary and type the
 * validated result. Task metadata round-trips through the database, so the
 * worker must never trust its shape blindly.
 */
function parsePersistedDraft(raw: unknown): DraftRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isMessageSource(record.source)) return null;
  if (typeof record.body !== "string" || record.body.length === 0) return null;
  const to = parseRecipients(record.to);
  if (!to) return null;
  const inReplyToId = optionalString(record.inReplyToId);
  const threadId = optionalString(record.threadId);
  const subject = optionalString(record.subject);
  const worldId = optionalString(record.worldId);
  const channelId = optionalString(record.channelId);
  const metadata =
    record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  return {
    source: record.source,
    to,
    body: record.body,
    ...(inReplyToId ? { inReplyToId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(subject ? { subject } : {}),
    ...(worldId ? { worldId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Register the single stable CHOOSE_OPTION task worker that executes (or
 * cancels) an owner-approved outbound send. Idempotent; called at plugin
 * init and defensively before every approval enqueue so an approval task
 * can never exist without its executing worker (issue #10723).
 *
 * Execution reconstructs the send from the draft payload persisted in the
 * task row at enqueue time — never from an in-memory closure — so an
 * approved send survives a process restart (issue #10721).
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
      const claims = claimsFor(rt);
      if (option === "cancel") {
        if (claims.has(taskId)) {
          throw new Error(
            `[OwnerSendPolicy] cannot cancel send approval ${taskId}: a confirm for it is already executing`,
          );
        }
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
      if (typeof rt.getTask !== "function") {
        throw new Error(
          "[OwnerSendPolicy] runtime.getTask is required to execute send approvals",
        );
      }
      if (claims.has(taskId)) {
        throw new Error(
          `[OwnerSendPolicy] send approval ${taskId} is already executing; nothing was sent twice`,
        );
      }
      claims.add(taskId);
      try {
        // Re-read the live row: a stale Task object replayed after the send
        // completed (row deleted) must not send a second time.
        const live = await rt.getTask(task.id);
        if (!live) {
          throw new Error(
            `[OwnerSendPolicy] send approval ${taskId} no longer exists (already sent or cancelled); nothing was sent`,
          );
        }
        const draft = parsePersistedDraft(live.metadata?.payload);
        if (!draft) {
          await rt.deleteTask(task.id);
          throw new Error(
            `[OwnerSendPolicy] send approval ${taskId} has a missing or invalid persisted draft payload; nothing was sent — please re-send the draft`,
          );
        }
        const service = getDefaultTriageService();
        const adapter = service.getAdapter(draft.source);
        if (!adapter) {
          throw new Error(
            `[OwnerSendPolicy] no "${draft.source}" message adapter is registered; nothing was sent — retry once the connector is available`,
          );
        }
        const { draftId, preview } = await adapter.createDraft(rt, draft);
        const record: DraftRecord = {
          draftId,
          source: draft.source,
          inReplyToId: draft.inReplyToId,
          threadId: draft.threadId,
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          preview,
          createdAtMs: Date.now(),
          sent: false,
          worldId: draft.worldId,
          channelId: draft.channelId,
        };
        service.getStore().saveDraft(record);
        const { externalId } = await adapter.sendDraft(rt, draftId);
        service.getStore().markDraftSent(draftId, externalId);
        await rt.deleteTask(task.id);
        logger.info(
          `[OwnerSendPolicy] approved send ${taskId} executed from the persisted draft payload (externalId=${externalId})`,
        );
        return undefined;
      } finally {
        claims.delete(taskId);
      }
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
    // The executor closure core hands us cannot survive a restart, so it is
    // intentionally unused: the worker reconstructs the send from the draft
    // payload persisted in the task row instead (issue #10721).
    async enqueueApproval(runtime, draft, _executor) {
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
          // The full executable payload. The OWNER_SEND_APPROVAL worker
          // reconstructs the send from this persisted state on confirm.
          payload: {
            source: draft.source,
            inReplyToId: draft.inReplyToId ?? null,
            threadId: draft.threadId ?? null,
            to: draft.to,
            subject: draft.subject ?? null,
            body: draft.body,
            worldId: draft.worldId ?? null,
            channelId: draft.channelId ?? null,
            metadata: draft.metadata ?? null,
          },
        },
      });
      return {
        requestId: String(requestId),
        preview: previewDraft(draft),
      };
    },
  };
}
