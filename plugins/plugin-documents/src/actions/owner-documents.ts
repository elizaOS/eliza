import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

/**
 * OWNER_DOCUMENTS umbrella action — Docs And Portals domain.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts)
 *
 * Reference subactions (per the lifeops source):
 *   - request_signature
 *   - request_approval
 *   - track_deadline
 *   - upload_asset
 *   - collect_id
 *   - close_request
 *
 * The full implementation (approval queue gating, scheduled-task deadline
 * tracking, signing-portal dispatch, document-request lifecycle) will be
 * ported here in a follow-up pass. For now this file exists so the plugin
 * registers cleanly and the runtime knows the action contract.
 */

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

const FAILURE_TEXT_PREFIX = `[${ACTION_NAME}]`;

function failure(reason: string, message: string): ActionResult {
  const text = `${FAILURE_TEXT_PREFIX} ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

interface OwnerDocumentsActionParameters {
  subaction?: unknown;
  op?: unknown;
  action?: unknown;
  requestId?: unknown;
  kind?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  deadline?: unknown;
  counterparty?: unknown;
  documentId?: unknown;
}

export const ownerDocumentsAction: Action = {
  name: ACTION_NAME,
  similes: [
    "OWNER_DOCUMENTS_REQUEST_SIGNATURE",
    "OWNER_DOCUMENTS_REQUEST_APPROVAL",
    "OWNER_DOCUMENTS_TRACK_DEADLINE",
    "OWNER_DOCUMENTS_UPLOAD_ASSET",
    "OWNER_DOCUMENTS_COLLECT_ID_OR_FORM",
    "OWNER_DOCUMENTS_CLOSE_REQUEST",
  ],
  description:
    "Owner-facing Docs And Portals umbrella action. Action-based dispatch covering signature requests, approval flows, deadline tracking, asset uploads, ID/form collection, and request closure.",
  parameters: [
    {
      name: "action",
      description: "Which OWNER_DOCUMENTS sub-operation to run.",
      required: true,
      schema: { type: "string", enum: [...SUBACTIONS] },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      schema: { type: "string", enum: [...SUBACTIONS] },
    },
    {
      name: "requestId",
      description: "Existing document-request id (close_request / updates).",
      schema: { type: "string" },
    },
    {
      name: "kind",
      description: "Document-request kind (signature/approval/asset/id_form).",
      schema: { type: "string" },
    },
    {
      name: "title",
      description: "Human-readable title for the request.",
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "Free-text description of what is being requested.",
      schema: { type: "string" },
    },
    {
      name: "url",
      description: "Portal URL or asset location.",
      schema: { type: "string" },
    },
    {
      name: "deadline",
      description: "ISO timestamp the request must be completed by.",
      schema: { type: "string" },
    },
    {
      name: "counterparty",
      description: "Counterparty (signer, approver, recipient).",
      schema: { type: "string" },
    },
    {
      name: "documentId",
      description: "Underlying document id to bind to the request.",
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts):
    // port the access-control + parameter validation from the lifeops handler.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as OwnerDocumentsActionParameters;
    const sub =
      readString(params.subaction) ??
      readString(params.op) ??
      readString(params.action);
    if (!sub) return failure("scaffold_stub", "No subaction specified.");

    const known = SUBACTIONS as readonly string[];
    if (!known.includes(sub)) {
      return failure("scaffold_stub", `Unsupported subaction '${sub}'.`);
    }

    switch (sub as Subaction) {
      case "request_signature":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts — request_signature branch)
        return failure(
          "scaffold_stub",
          "OWNER_DOCUMENTS.request_signature is not migrated yet.",
        );
      case "request_approval":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts — request_approval branch)
        return failure(
          "scaffold_stub",
          "OWNER_DOCUMENTS.request_approval is not migrated yet.",
        );
      case "track_deadline":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts — track_deadline branch,
        // plugins/plugin-personal-assistant/src/lifeops/scheduled-task/* for the runner hookup)
        return failure(
          "scaffold_stub",
          "OWNER_DOCUMENTS.track_deadline is not migrated yet.",
        );
      case "upload_asset":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts — upload_asset branch,
        // plugins/plugin-personal-assistant/src/lifeops/approval-queue.ts for the gating)
        return failure(
          "scaffold_stub",
          "OWNER_DOCUMENTS.upload_asset is not migrated yet.",
        );
      case "collect_id":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts — collect_id branch)
        return failure(
          "scaffold_stub",
          "OWNER_DOCUMENTS.collect_id is not migrated yet.",
        );
      case "close_request":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/document.ts — close_request branch,
        // plugins/plugin-personal-assistant/src/types/document-request.ts for the record shape)
        return failure(
          "scaffold_stub",
          "OWNER_DOCUMENTS.close_request is not migrated yet.",
        );
      default:
        return failure("scaffold_stub", `Unsupported subaction '${sub}'.`);
    }
  },
  examples: [],
};

export default ownerDocumentsAction;
