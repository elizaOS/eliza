/**
 * Owner send-approval policy: the {@link SendPolicy} that forces outbound
 * messages on approval-gated connectors through explicit owner confirmation
 * before dispatch. `shouldRequireApproval` consults the connector registry (a
 * connector's `requiresApproval` flag); `enqueueApproval` persists the draft as
 * a CHOOSE_OPTION `ScheduledTask` on the owner approval queue.
 *
 * Approval executes through one stable task worker (`OWNER_SEND_APPROVAL`) that
 * core's CHOOSE_OPTION action resolves by task name, dispatching on task
 * metadata rather than a per-task name. The worker reconstructs the send purely
 * from the draft payload persisted in the task row — never from an in-memory
 * closure — so an approved send survives a process restart (#10721), and an
 * in-process claim set makes a concurrent duplicate confirm fail rather than
 * double-send (#11090).
 */
import type {
  DraftRecord,
  DraftRequest,
  IAgentRuntime,
  MessageSource,
  SendPolicy,
  Task,
  TaskService,
} from "@elizaos/core";
import { getDefaultTriageService, logger, ServiceType } from "@elizaos/core";
import { getConnectorRegistry } from "../connectors/registry.js";

/**
 * Stable task (and task-worker) name for owner send approvals. Core's
 * CHOOSE_OPTION action resolves the worker by the task's `name`, so every
 * approval task uses this one name and the worker dispatches on task
 * metadata (`actionName` + the persisted draft payload) instead of a
 * per-task name.
 */
export const OWNER_SEND_APPROVAL_TASK_NAME = "OWNER_SEND_APPROVAL";
export const OWNER_SEND_OUTBOX_TASK_NAME = "OWNER_SEND_OUTBOX";

const OWNER_SEND_RETRY_INTERVAL_MS = 1_000;

/** A connector-proven failure before the provider accepted any side effect. */
export class OwnerSendKnownNonDeliveryError extends Error {
  readonly accepted = false;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OwnerSendKnownNonDeliveryError";
  }
}

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
  if (
    runtime.getTaskWorker(OWNER_SEND_APPROVAL_TASK_NAME) &&
    runtime.getTaskWorker(OWNER_SEND_OUTBOX_TASK_NAME)
  ) {
    return;
  }
  runtime.registerTaskWorker({
    name: OWNER_SEND_OUTBOX_TASK_NAME,
    execute: async (rt, _options, task) => {
      try {
        await dispatchApprovedDraft(rt, task);
      } catch (error) {
        if (error instanceof OwnerSendKnownNonDeliveryError) throw error;
        if (task.id) {
          const latest = await rt.getTask(task.id);
          if (latest) {
            await rt.updateTask(task.id, {
              metadata: {
                ...latest.metadata,
                paused: true,
                outboxReconciliationRequired: true,
                outboxLastError:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
        logger.error(
          { taskId: task.id, error },
          "[OwnerSendPolicy] ambiguous outbox outcome paused for reconciliation",
        );
      }
      return undefined;
    },
  });
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
        if (live.name === OWNER_SEND_OUTBOX_TASK_NAME) {
          const delivered = live.metadata?.outboxReceipt;
          throw new Error(
            delivered
              ? `[OwnerSendPolicy] send approval ${taskId} was already delivered and has a durable receipt; nothing was sent twice`
              : `[OwnerSendPolicy] send approval ${taskId} was already approved and is pending delivery; nothing was sent twice`,
          );
        }
        if (live.metadata?.outboxReconciliationRequired === true) {
          throw new Error(
            `[OwnerSendPolicy] send approval ${taskId} has an ambiguous provider outcome and requires manual reconciliation; automatic retry is unsafe`,
          );
        }
        const draft = parsePersistedDraft(live.metadata?.payload);
        if (!draft) {
          await rt.deleteTask(task.id);
          throw new Error(
            `[OwnerSendPolicy] send approval ${taskId} has a missing or invalid persisted draft payload; nothing was sent — please re-send the draft`,
          );
        }
        try {
          await dispatchApprovedDraft(rt, live, draft);
          return undefined;
        } catch (error) {
          const latest = await rt.getTask(task.id);
          if (latest) {
            if (error instanceof OwnerSendKnownNonDeliveryError) {
              await rt.updateTask(task.id, {
                name: OWNER_SEND_OUTBOX_TASK_NAME,
                tags: [
                  "queue",
                  "repeat",
                  "OUTBOX",
                  OWNER_SEND_OUTBOX_TASK_NAME,
                ],
                dueAt:
                  (typeof rt.getService === "function"
                    ? rt
                        .getService<TaskService>(ServiceType.TASK)
                        ?.currentTime()
                        .getTime()
                    : undefined) ?? Date.now(),
                metadata: {
                  ...latest.metadata,
                  updateInterval: OWNER_SEND_RETRY_INTERVAL_MS,
                  maxFailures: 5,
                },
              });
            } else {
              await rt.updateTask(task.id, {
                metadata: {
                  ...latest.metadata,
                  outboxReconciliationRequired: true,
                  outboxLastError:
                    error instanceof Error ? error.message : String(error),
                },
              });
            }
          }
          throw error;
        }
      } finally {
        claims.delete(taskId);
      }
    },
  });
}

async function dispatchApprovedDraft(
  runtime: IAgentRuntime,
  task: Task,
  parsedDraft?: DraftRequest,
): Promise<void> {
  if (!task.id) {
    throw new Error("[OwnerSendPolicy] outbox task is missing its id");
  }
  const draft = parsedDraft ?? parsePersistedDraft(task.metadata?.payload);
  if (!draft) {
    await runtime.deleteTask(task.id);
    throw new Error(
      `[OwnerSendPolicy] send approval ${String(task.id)} has a missing or invalid persisted draft payload; nothing was sent — please re-send the draft`,
    );
  }
  const service = getDefaultTriageService();
  const adapter = service.getAdapter(draft.source);
  if (!adapter) {
    throw new OwnerSendKnownNonDeliveryError(
      `[OwnerSendPolicy] no "${draft.source}" message adapter is registered; nothing was sent — retry once the connector is available`,
    );
  }
  const persisted = task.metadata?.outboxDraft;
  let record: DraftRecord;
  if (persisted && typeof persisted === "object" && !Array.isArray(persisted)) {
    record = persisted as unknown as DraftRecord;
  } else {
    const { draftId, preview } = await adapter.createDraft(runtime, draft);
    record = {
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
    await runtime.updateTask(task.id, {
      metadata: { ...task.metadata, outboxDraft: record },
    });
  }
  service.getStore().saveDraft(record);
  if (record.sent) {
    return;
  }
  const { externalId } = await adapter.sendDraft(runtime, record.draftId);
  service.getStore().markDraftSent(record.draftId, externalId);
  const latest = await runtime.getTask(task.id);
  if (!latest) {
    throw new Error(
      `[OwnerSendPolicy] approved send ${String(task.id)} was accepted but its durable outbox row disappeared`,
    );
  }
  await runtime.updateTask(task.id, {
    name: OWNER_SEND_OUTBOX_TASK_NAME,
    tags: ["queue", "repeat", "OUTBOX", OWNER_SEND_OUTBOX_TASK_NAME],
    metadata: {
      ...latest.metadata,
      paused: true,
      updateInterval:
        latest.metadata?.updateInterval ?? OWNER_SEND_RETRY_INTERVAL_MS,
      outboxDraft: { ...record, sent: true, sentExternalId: externalId },
      outboxReceipt: {
        externalId,
        draftId: record.draftId,
        accepted: true,
      },
    },
  });
  logger.info(
    `[OwnerSendPolicy] approved send ${String(task.id)} executed from the durable outbox (externalId=${externalId})`,
  );
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
