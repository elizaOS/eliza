/**
 * `OWNER_DOCUMENTS` umbrella action — Docs And Portals domain.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Docs And Portals.
 *
 * Wave-1 scaffold. Real persistence + browser routing lands in Wave-2; this
 * file gives Wave-2 scenarios a stable surface to assert against. The six
 * PRD-named actions are exposed as similes on a single umbrella that
 * dispatches on `subaction`:
 *
 *   - `request_signature`  ← `OWNER_DOCUMENTS_REQUEST_SIGNATURE`
 *   - `request_approval`   ← `OWNER_DOCUMENTS_REQUEST_APPROVAL`
 *   - `track_deadline`     ← `OWNER_DOCUMENTS_TRACK_DEADLINE`
 *   - `upload_asset`       ← `OWNER_DOCUMENTS_UPLOAD_ASSET`
 *   - `collect_id`         ← `OWNER_DOCUMENTS_COLLECT_ID_OR_FORM`
 *   - `close_request`      ← `OWNER_DOCUMENTS_CLOSE_REQUEST`
 *
 * Each subaction composes existing services (`SCHEDULED_TASK` runner for
 * deadline tracking, `ApprovalQueue` for owner-gated dispatch) rather than
 * inventing storage. The DocumentRequest record itself is held in an
 * in-memory map keyed by runtime — Wave-2 will migrate to a `documents`
 * repository alongside ScheduledTask.
 *
 * Approval gating:
 *   - `request_signature` and `upload_asset` enqueue an `ApprovalRequest`
 *     in the `draft` -> `pending` state and wait for owner approval before
 *     dispatching the actual signing portal call / browser upload.
 *   - `request_approval`, `track_deadline`, `collect_id`, `close_request`
 *     are operator-callable without approval gating.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import type {
  ScheduledTaskRunnerHandle,
  ScheduledTaskTrigger,
} from "../lifeops/scheduled-task/index.js";
import { getScheduledTaskRunner } from "../lifeops/scheduled-task/service.js";
import type {
  DocumentRequest,
  DocumentRequestKind,
  DocumentRequestStatus,
} from "../types/document-request.js";

const ACTION_NAME = "OWNER_DOCUMENTS";

const SUBACTIONS = [
  "request_signature",
  "request_approval",
  "track_deadline",
  "upload_asset",
  "collect_id",
  "close_request",
] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "OWNER_DOCUMENTS_REQUEST_SIGNATURE",
  "OWNER_DOCUMENTS_REQUEST_APPROVAL",
  "OWNER_DOCUMENTS_TRACK_DEADLINE",
  "OWNER_DOCUMENTS_UPLOAD_ASSET",
  "OWNER_DOCUMENTS_COLLECT_ID_OR_FORM",
  "OWNER_DOCUMENTS_CLOSE_REQUEST",
  "PAPERWORK",
];

/**
 * Map planner-facing simile (e.g.
 * `OWNER_DOCUMENTS_REQUEST_SIGNATURE`) to the umbrella subaction the handler
 * dispatches on. The map is checked when the handler is invoked through a
 * simile virtual rather than the `subaction` arg.
 */
const SIMILE_TO_SUBACTION: Readonly<Record<string, Subaction>> = {
  OWNER_DOCUMENTS_REQUEST_SIGNATURE: "request_signature",
  OWNER_DOCUMENTS_REQUEST_APPROVAL: "request_approval",
  OWNER_DOCUMENTS_TRACK_DEADLINE: "track_deadline",
  OWNER_DOCUMENTS_UPLOAD_ASSET: "upload_asset",
  OWNER_DOCUMENTS_COLLECT_ID_OR_FORM: "collect_id",
  OWNER_DOCUMENTS_CLOSE_REQUEST: "close_request",
};

interface DocActionParameters {
  /** Canonical subaction selector. */
  subaction?: Subaction | string;
  /** Alias accepted from planner output. */
  action?: Subaction | string;
  /** Alias accepted from planner output. */
  op?: Subaction | string;
  /** Existing DocumentRequest id (track_deadline, close_request). */
  documentRequestId?: string;
  /** Entity (person) ref for the requestee. */
  requesteeEntityId?: string;
  /** Short human label, e.g. "Partnership NDA". */
  documentTitle?: string;
  /** ISO-8601 deadline. */
  deadline?: string;
  /** Portal endpoint for upload / collect_id. */
  portalUrl?: string;
  /** Local path or URL of the asset to upload. */
  assetPath?: string;
  /** "deck" | "headshot" | "id" | "form" | etc. */
  assetKind?: string;
  /** Optional signing portal URL (DocuSign / HelloSign / etc.). */
  signatureUrl?: string;
  /** Approval-class label for `request_approval`. */
  approvalReason?: string;
  /** Free-form note recorded on the DocumentRequest. */
  note?: string;
  /** close_request: outcome ("completed" | "expired" | "cancelled"). */
  resolution?: "completed" | "expired" | "cancelled";
}

/**
 * In-memory DocumentRequest store. Keyed by `runtime.agentId` so multiple
 * runtimes in one test process don't bleed into each other. Wave-2 replaces
 * this with a `documents` table on `LifeOpsRepository`.
 */
const DOCUMENT_STORE = new Map<string, Map<string, DocumentRequest>>();

function getDocStore(runtime: IAgentRuntime): Map<string, DocumentRequest> {
  const key = String(runtime.agentId);
  let store = DOCUMENT_STORE.get(key);
  if (!store) {
    store = new Map();
    DOCUMENT_STORE.set(key, store);
  }
  return store;
}

function newDocumentRequestId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const upper = trimmed.toUpperCase();
  if (upper in SIMILE_TO_SUBACTION) {
    return SIMILE_TO_SUBACTION[upper] ?? null;
  }
  const lower = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(lower)
    ? (lower as Subaction)
    : null;
}

function resolveSubaction(params: DocActionParameters): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op)
  );
}

function getParams(options: HandlerOptions | undefined): DocActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as DocActionParameters;
  }
  return {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function kindForSubaction(subaction: Subaction): DocumentRequestKind {
  switch (subaction) {
    case "request_signature":
      return "signature";
    case "request_approval":
      return "approval";
    case "upload_asset":
      return "upload";
    case "collect_id":
      return "collect_id";
    case "track_deadline":
    case "close_request":
      // No new kind — these operate on an existing request.
      return "signature";
  }
}

function missing(name: string, subaction: Subaction): ActionResult {
  return {
    success: false,
    text: `I need ${name} to ${subaction.replace("_", " ")}.`,
    data: { subaction, error: `MISSING_${name.toUpperCase()}` },
  };
}

function notFound(
  documentRequestId: string,
  subaction: Subaction,
): ActionResult {
  return {
    success: false,
    text: `No DocumentRequest found with id ${documentRequestId}.`,
    data: { subaction, error: "DOCUMENT_REQUEST_NOT_FOUND" },
  };
}

function saveDocument(
  runtime: IAgentRuntime,
  doc: DocumentRequest,
): DocumentRequest {
  const store = getDocStore(runtime);
  store.set(doc.id, doc);
  return doc;
}

function patchDocument(
  runtime: IAgentRuntime,
  id: string,
  patch: Partial<DocumentRequest>,
): DocumentRequest | null {
  const store = getDocStore(runtime);
  const existing = store.get(id);
  if (!existing) return null;
  const next: DocumentRequest = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
  store.set(id, next);
  return next;
}

interface RunnerScope {
  readonly runtime: IAgentRuntime;
  readonly runner: ScheduledTaskRunnerHandle;
  readonly agentId: string;
  readonly subjectUserId: string;
}

function makeScope(runtime: IAgentRuntime, message: Memory): RunnerScope {
  const agentId = String(runtime.agentId);
  const runner = getScheduledTaskRunner(runtime, { agentId });
  const subjectUserId =
    typeof message.entityId === "string" && message.entityId.length > 0
      ? message.entityId
      : agentId;
  return { runtime, runner, agentId, subjectUserId };
}

async function scheduleDeadlineTask(
  scope: RunnerScope,
  doc: DocumentRequest,
): Promise<string | undefined> {
  if (!doc.deadline) return undefined;
  const trigger: ScheduledTaskTrigger = {
    kind: "once",
    atIso: doc.deadline,
  };
  const task = await scope.runner.schedule({
    kind: "watcher",
    promptInstructions: `Document "${doc.title}" deadline reached. Verify status of DocumentRequest ${doc.id} and escalate if still ${doc.status}.`,
    trigger,
    priority: "medium",
    subject: { kind: "document", id: doc.id },
    metadata: {
      documentRequestId: doc.id,
      documentKind: doc.kind,
    },
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: scope.agentId,
    ownerVisible: true,
  });
  return task.taskId;
}

// ── Subaction handlers ───────────────────────────────────

async function handleRequestSignature(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "request_signature";
  const requesteeEntityId = params.requesteeEntityId?.trim();
  if (!requesteeEntityId) return missing("requesteeEntityId", subaction);
  const documentTitle = params.documentTitle?.trim();
  if (!documentTitle) return missing("documentTitle", subaction);
  const deadline = params.deadline?.trim();
  if (!deadline) return missing("deadline", subaction);

  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "signature",
    requesteeEntityId,
    title: documentTitle,
    deadline,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.note ? { note: params.note } : {}),
  };

  // Owner approval gate. The actual signing dispatch waits for
  // RESOLVE_REQUEST approve to flip the approval queue entry to `done`.
  const queue = createApprovalQueue(scope.runtime, { agentId: scope.agentId });
  const approvalRequest = await queue.enqueue({
    requestedBy: ACTION_NAME,
    subjectUserId: scope.subjectUserId,
    action: "sign_document",
    payload: {
      action: "sign_document",
      documentId: doc.id,
      documentName: doc.title,
      signatureUrl: params.signatureUrl?.trim() ?? "",
      deadline,
    },
    channel: "internal",
    reason: `Request signature from ${requesteeEntityId} on "${doc.title}" by ${deadline}`,
    expiresAt: new Date(
      Date.parse(deadline) || Date.now() + 24 * 60 * 60 * 1000,
    ),
  });

  // Schedule the deadline watcher up front so a SCHEDULED_TASK exists even
  // before the owner approves. The watcher metadata carries the documentId
  // so the Wave-2 escalator can branch on document state.
  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);

  const saved = saveDocument(scope.runtime, {
    ...doc,
    status: "pending",
    approvalRequestId: approvalRequest.id,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  logger.info(
    `[OWNER_DOCUMENTS] request_signature id=${saved.id} requestee=${requesteeEntityId} deadline=${deadline} approval=${approvalRequest.id}`,
  );

  return {
    success: true,
    text: `Queued signature request for "${saved.title}" pending owner approval.`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      approvalRequestId: approvalRequest.id,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleRequestApproval(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "request_approval";
  const documentTitle = params.documentTitle?.trim();
  if (!documentTitle) return missing("documentTitle", subaction);

  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "approval",
    title: documentTitle,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.requesteeEntityId
      ? { requesteeEntityId: params.requesteeEntityId.trim() }
      : {}),
    ...(params.deadline ? { deadline: params.deadline.trim() } : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);
  const saved = saveDocument(scope.runtime, {
    ...doc,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  logger.info(
    `[OWNER_DOCUMENTS] request_approval id=${saved.id} title="${documentTitle}" reason=${params.approvalReason ?? "(none)"}`,
  );

  return {
    success: true,
    text: `Logged approval request for "${saved.title}".`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleTrackDeadline(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "track_deadline";
  const documentRequestId = params.documentRequestId?.trim();
  if (!documentRequestId) return missing("documentRequestId", subaction);
  const store = getDocStore(scope.runtime);
  const existing = store.get(documentRequestId);
  if (!existing) return notFound(documentRequestId, subaction);

  const deadline = params.deadline?.trim() ?? existing.deadline;
  if (!deadline) return missing("deadline", subaction);

  const patched = patchDocument(scope.runtime, documentRequestId, {
    deadline,
    status: existing.status === "draft" ? "pending" : existing.status,
  });
  if (!patched) return notFound(documentRequestId, subaction);
  const scheduledTaskId = await scheduleDeadlineTask(scope, patched);
  const next = patchDocument(scope.runtime, documentRequestId, {
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });
  if (!next) return notFound(documentRequestId, subaction);

  logger.info(
    `[OWNER_DOCUMENTS] track_deadline id=${next.id} deadline=${deadline} task=${scheduledTaskId ?? "(none)"}`,
  );

  return {
    success: true,
    text: `Tracking ${next.title} deadline ${deadline}.`,
    data: {
      subaction,
      documentRequest: next,
      documentRequestId: next.id,
      status: next.status,
      scheduledTaskId: next.scheduledTaskId ?? null,
    },
  };
}

async function handleUploadAsset(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "upload_asset";
  const portalUrl = params.portalUrl?.trim();
  if (!portalUrl) return missing("portalUrl", subaction);
  const assetPath = params.assetPath?.trim();
  if (!assetPath) return missing("assetPath", subaction);
  const assetKind = params.assetKind?.trim();
  if (!assetKind) return missing("assetKind", subaction);

  const documentTitle =
    params.documentTitle?.trim() ?? `Upload ${assetKind} to ${portalUrl}`;
  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "upload",
    title: documentTitle,
    portalUrl,
    assetKind,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.deadline ? { deadline: params.deadline.trim() } : {}),
    ...(params.requesteeEntityId
      ? { requesteeEntityId: params.requesteeEntityId.trim() }
      : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  // Owner approval gate. Sensitive uploads (decks, IDs) must not dispatch
  // through the browser bridge without explicit consent — this matches the
  // PRD §Approval-Required Operations row "Upload sensitive document or ID".
  const queue = createApprovalQueue(scope.runtime, { agentId: scope.agentId });
  const approvalRequest = await queue.enqueue({
    requestedBy: ACTION_NAME,
    subjectUserId: scope.subjectUserId,
    action: "execute_workflow",
    payload: {
      action: "execute_workflow",
      workflowId: "doc.upload_asset",
      input: {
        documentId: doc.id,
        portalUrl,
        assetPath,
        assetKind,
      },
    },
    channel: "browser",
    reason: `Upload ${assetKind} to ${portalUrl}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);
  const saved = saveDocument(scope.runtime, {
    ...doc,
    status: "pending",
    approvalRequestId: approvalRequest.id,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  // TODO Wave-2: route through BROWSER.navigate + BROWSER.upload once the
  // approval flips to `approved`. For now the approval queue entry is the
  // executable contract the Wave-2 scenarios assert against.
  logger.info(
    `[OWNER_DOCUMENTS] upload_asset id=${saved.id} portal=${portalUrl} asset=${assetKind} approval=${approvalRequest.id}`,
  );

  return {
    success: true,
    text: `Queued ${assetKind} upload to ${portalUrl} pending owner approval.`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      approvalRequestId: approvalRequest.id,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleCollectId(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "collect_id";
  const requesteeEntityId = params.requesteeEntityId?.trim();
  if (!requesteeEntityId) return missing("requesteeEntityId", subaction);
  const assetKind = params.assetKind?.trim();
  if (!assetKind) return missing("assetKind", subaction);

  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "collect_id",
    requesteeEntityId,
    title:
      params.documentTitle?.trim() ??
      `Collect ${assetKind} from ${requesteeEntityId}`,
    assetKind,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.portalUrl ? { portalUrl: params.portalUrl.trim() } : {}),
    ...(params.deadline ? { deadline: params.deadline.trim() } : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);
  const saved = saveDocument(scope.runtime, {
    ...doc,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  logger.info(
    `[OWNER_DOCUMENTS] collect_id id=${saved.id} requestee=${requesteeEntityId} kind=${assetKind}`,
  );

  return {
    success: true,
    text: `Tracking ${assetKind} collection from ${requesteeEntityId}.`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleCloseRequest(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "close_request";
  const documentRequestId = params.documentRequestId?.trim();
  if (!documentRequestId) return missing("documentRequestId", subaction);

  const resolution: DocumentRequestStatus = params.resolution ?? "completed";
  if (
    resolution !== "completed" &&
    resolution !== "expired" &&
    resolution !== "cancelled"
  ) {
    return {
      success: false,
      text: `Invalid resolution "${resolution}". Use completed | expired | cancelled.`,
      data: { subaction, error: "INVALID_RESOLUTION" },
    };
  }

  const patched = patchDocument(scope.runtime, documentRequestId, {
    status: resolution,
  });
  if (!patched) return notFound(documentRequestId, subaction);

  // Cancel the linked deadline watcher so we don't fire on a closed request.
  if (patched.scheduledTaskId) {
    try {
      await scope.runner.apply(patched.scheduledTaskId, "dismiss", {
        reason: `document ${resolution}`,
      });
    } catch (error) {
      logger.warn(
        `[OWNER_DOCUMENTS] close_request failed to dismiss task ${patched.scheduledTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  logger.info(
    `[OWNER_DOCUMENTS] close_request id=${patched.id} resolution=${resolution}`,
  );

  return {
    success: true,
    text: `Closed DocumentRequest ${patched.id} as ${resolution}.`,
    data: {
      subaction,
      documentRequest: patched,
      documentRequestId: patched.id,
      status: patched.status,
    },
  };
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: {
        text: "Get the NDA signed by Alice before Friday — she's at entity-alice-001.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Queued signature request for the NDA pending owner approval.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "Upload the deck to the Solana Breakpoint speaker portal.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Queued deck upload to the speaker portal pending owner approval.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Close out doc-abc123 — it's signed." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Closed DocumentRequest doc-abc123 as completed.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const ownerDocumentsAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
    name: ACTION_NAME,
    similes: SIMILE_NAMES.slice(),
    tags: [
      "domain:docs",
      "capability:read",
      "capability:write",
      "capability:update",
      "capability:schedule",
      "surface:internal",
    ],
    description:
      "Manage the owner's document workflow surface: signature requests, approvals, deadline tracking, portal uploads, ID/form collection, and request close-out. Subactions: request_signature, request_approval, track_deadline, upload_asset, collect_id, close_request.",
    descriptionCompressed:
      "docs: request_signature|request_approval|track_deadline|upload_asset|collect_id|close_request; deadline-aware; owner-gated for signature+upload",
    routingHint:
      'owner document signature/approval/upload/portal/ID-form intent ("get this signed", "send for approval", "upload deck to portal", "track NDA deadline", "close out the doc request") -> OWNER_DOCUMENTS; approval queue resolution stays on RESOLVE_REQUEST',
    contexts: ["docs", "tasks", "calendar", "contacts"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
    parameters: [
      {
        name: "action",
        description:
          "Canonical document operation: request_signature | request_approval | track_deadline | upload_asset | collect_id | close_request.",
        schema: { type: "string" as const, enum: [...SUBACTIONS] },
      },
      {
        name: "documentRequestId",
        description:
          "Existing DocumentRequest id. Required for track_deadline and close_request.",
        schema: { type: "string" as const },
      },
      {
        name: "requesteeEntityId",
        description:
          "Entity id of the person we are asking. Required for request_signature and collect_id.",
        schema: { type: "string" as const },
      },
      {
        name: "documentTitle",
        description: "Short human-readable label for the document.",
        schema: { type: "string" as const },
      },
      {
        name: "deadline",
        description: "ISO-8601 deadline for the request.",
        schema: { type: "string" as const },
      },
      {
        name: "portalUrl",
        description:
          "Portal endpoint for upload_asset and (optionally) collect_id.",
        schema: { type: "string" as const },
      },
      {
        name: "assetPath",
        description:
          "Local path or URL of the asset to upload. Required for upload_asset.",
        schema: { type: "string" as const },
      },
      {
        name: "assetKind",
        description:
          "What kind of asset: deck, headshot, id, form, etc. Required for upload_asset and collect_id.",
        schema: { type: "string" as const },
      },
      {
        name: "signatureUrl",
        description:
          "Optional signing portal URL (DocuSign / HelloSign / etc.).",
        schema: { type: "string" as const },
      },
      {
        name: "approvalReason",
        description: "Reason label for request_approval.",
        schema: { type: "string" as const },
      },
      {
        name: "note",
        description: "Free-form note recorded on the DocumentRequest.",
        schema: { type: "string" as const },
      },
      {
        name: "resolution",
        description:
          "close_request only: completed | expired | cancelled. Defaults to completed.",
        schema: {
          type: "string" as const,
          enum: ["completed", "expired", "cancelled"],
        },
      },
    ],
    examples,
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state,
      options,
      callback,
    ): Promise<ActionResult> => {
      if (!(await hasLifeOpsAccess(runtime, message))) {
        const text = "Document workflow control is restricted to the owner.";
        await callback?.({ text });
        return { text, success: false, data: { error: "PERMISSION_DENIED" } };
      }

      const params = getParams(options);
      const subaction = resolveSubaction(params);
      if (!subaction) {
        return {
          success: false,
          text: "Tell me which document operation: request_signature, request_approval, track_deadline, upload_asset, collect_id, or close_request.",
          data: { error: "MISSING_SUBACTION" },
        };
      }

      const scope = makeScope(runtime, message);
      let result: ActionResult;
      switch (subaction) {
        case "request_signature":
          result = await handleRequestSignature(scope, params);
          break;
        case "request_approval":
          result = await handleRequestApproval(scope, params);
          break;
        case "track_deadline":
          result = await handleTrackDeadline(scope, params);
          break;
        case "upload_asset":
          result = await handleUploadAsset(scope, params);
          break;
        case "collect_id":
          result = await handleCollectId(scope, params);
          break;
        case "close_request":
          result = await handleCloseRequest(scope, params);
          break;
      }

      if (result.text) {
        await callback?.({
          text: result.text,
          source: "action",
          action: ACTION_NAME,
        });
      }
      return result;
    },
};

// Test-only export: lets the unit test reset between cases. Production code
// must not depend on this — Wave-2 swaps the in-memory map for a repository.
export function __resetDocumentStoreForTests(): void {
  DOCUMENT_STORE.clear();
}

// Test-only export of the kind mapper for completeness.
export function __kindForSubactionForTests(s: Subaction): DocumentRequestKind {
  return kindForSubaction(s);
}
