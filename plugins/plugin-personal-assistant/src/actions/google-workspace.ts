/** Exposes owner-scoped Google Drive, Docs, and Sheets reads and writes through the existing LifeOps DriveDomain. */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { requireConfirmation } from "@elizaos/core";
import { hasLifeOpsAccess, INTERNAL_URL } from "../lifeops/access.js";
import { LifeOpsService } from "../lifeops/service.js";

const ACTION_NAME = "GOOGLE_WORKSPACE";
const SUBACTIONS = [
  "create_file",
  "get_file",
  "update_sheet",
  "get_sheet",
] as const;
type GoogleWorkspaceSubaction = (typeof SUBACTIONS)[number];

type WorkspaceParams = {
  action?: GoogleWorkspaceSubaction;
  grantId?: string;
  fileId?: string;
  name?: string;
  mimeType?: string;
  content?: string;
  parentFolderId?: string;
  spreadsheetId?: string;
  range?: string;
  values?: ReadonlyArray<ReadonlyArray<string | number>>;
};

function paramsFrom(options: HandlerOptions | undefined): WorkspaceParams {
  const raw = (options as { parameters?: unknown } | undefined)?.parameters;
  return raw && typeof raw === "object" ? (raw as WorkspaceParams) : {};
}

function missing(name: string, action: GoogleWorkspaceSubaction): ActionResult {
  return {
    success: false,
    text: `Missing required parameter: ${name}.`,
    data: { actionName: ACTION_NAME, action, error: "INVALID_PARAMETERS" },
  };
}

async function requireWriteConfirmation(args: {
  runtime: IAgentRuntime;
  message: Memory;
  action: "create_file" | "update_sheet";
  key: string;
  prompt: string;
}): Promise<ActionResult | undefined> {
  const decision = await requireConfirmation({
    runtime: args.runtime,
    message: args.message,
    actionName: ACTION_NAME,
    pendingKey: `${args.action}:${args.key}`,
    prompt: args.prompt,
  });
  if (decision.status === "confirmed") return undefined;
  return {
    success: false,
    text:
      decision.status === "pending"
        ? `${args.prompt} Reply yes to confirm or no to cancel.`
        : "Google Workspace write cancelled.",
    data: {
      actionName: ACTION_NAME,
      action: args.action,
      draft: decision.status === "pending",
      awaitingUserInput: decision.status === "pending",
      error:
        decision.status === "pending"
          ? "DRAFT_REQUIRES_CONFIRMATION"
          : "CANCELLED",
    },
  };
}

async function handleGoogleWorkspace(
  runtime: IAgentRuntime,
  message: Memory,
  options?: HandlerOptions,
): Promise<ActionResult> {
  const params = paramsFrom(options);
  const action = params.action;
  if (!action || !SUBACTIONS.includes(action)) {
    return {
      success: false,
      text: `Missing or invalid action. Use: ${SUBACTIONS.join(", ")}.`,
      data: { actionName: ACTION_NAME, error: "INVALID_ACTION" },
    };
  }
  const service = new LifeOpsService(runtime);

  if (action === "create_file") {
    const name = params.name?.trim();
    if (!name) return missing("name", action);
    const mimeType = params.mimeType?.trim();
    if (!mimeType) return missing("mimeType", action);
    const held = await requireWriteConfirmation({
      runtime,
      message,
      action,
      key: `${params.parentFolderId ?? "root"}:${name}`,
      prompt: `Create Google Drive file "${name}"?`,
    });
    if (held) return held;
    const file = await service.createDriveFile(INTERNAL_URL, {
      side: "owner",
      grantId: params.grantId,
      name,
      mimeType,
      content: params.content,
      parentFolderId: params.parentFolderId,
    });
    return {
      success: true,
      text: `Created Google Drive file "${file.name}" (${file.id}).`,
      data: {
        actionName: ACTION_NAME,
        action,
        file,
        receipt: { provider: "google-drive", providerFileId: file.id },
      },
    };
  }

  if (action === "get_file") {
    const fileId = params.fileId?.trim();
    if (!fileId) return missing("fileId", action);
    const file = await service.getDriveFile(INTERNAL_URL, {
      side: "owner",
      grantId: params.grantId,
      fileId,
    });
    return {
      success: true,
      text: `Read Google Drive file "${file.name}" (${file.id}).`,
      data: { actionName: ACTION_NAME, action, file },
    };
  }

  if (action === "update_sheet") {
    const spreadsheetId = params.spreadsheetId?.trim();
    if (!spreadsheetId) return missing("spreadsheetId", action);
    const range = params.range?.trim();
    if (!range) return missing("range", action);
    if (!Array.isArray(params.values) || params.values.length === 0) {
      return missing("values", action);
    }
    const held = await requireWriteConfirmation({
      runtime,
      message,
      action,
      key: `${spreadsheetId}:${range}`,
      prompt: `Update Google Sheet ${spreadsheetId} range ${range}?`,
    });
    if (held) return held;
    const updated = await service.updateSheetCells(INTERNAL_URL, {
      side: "owner",
      grantId: params.grantId,
      spreadsheetId,
      range,
      values: params.values,
    });
    return {
      success: true,
      text: `Updated ${updated.updatedCells} Google Sheet cell(s) in ${updated.updatedRange}.`,
      data: {
        actionName: ACTION_NAME,
        action,
        spreadsheetId,
        ...updated,
        receipt: {
          provider: "google-sheets",
          providerSpreadsheetId: spreadsheetId,
          updatedRange: updated.updatedRange,
        },
      },
    };
  }

  const spreadsheetId = params.spreadsheetId?.trim();
  if (!spreadsheetId) return missing("spreadsheetId", action);
  const sheet = await service.getSheetContent(INTERNAL_URL, {
    side: "owner",
    grantId: params.grantId,
    spreadsheetId,
    range: params.range,
  });
  return {
    success: true,
    text: `Read Google Sheet "${sheet.title}" (${spreadsheetId}).`,
    data: { actionName: ACTION_NAME, action, spreadsheetId, sheet },
  };
}

export const googleWorkspaceAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: ["GOOGLE_DRIVE", "GOOGLE_DOCS", "GOOGLE_SHEETS"],
  description:
    "Owner Google Workspace files. Actions: create_file, get_file, update_sheet, get_sheet. Drive and Sheets writes require confirmation; reads return provider IDs and exact content.",
  descriptionCompressed:
    "Google Workspace create_file|get_file|update_sheet|get_sheet; writes require confirmation",
  routingHint:
    "Drive file create/read or Google Sheet update/read -> GOOGLE_WORKSPACE with the exact provider target",
  contexts: ["documents", "files", "spreadsheets", "connectors"],
  roleGate: { minRole: "OWNER" },
  tags: [
    "domain:documents",
    "capability:read",
    "capability:write",
    "effect:receipt-required",
    "surface:remote-api",
  ],
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description: SUBACTIONS.join(" | "),
      required: true,
      schema: { type: "string", enum: [...SUBACTIONS] },
    },
    ...[
      "grantId",
      "fileId",
      "name",
      "mimeType",
      "content",
      "parentFolderId",
      "spreadsheetId",
      "range",
    ].map((name) => ({
      name,
      description: `${name} for the selected Google Workspace operation.`,
      required: false,
      schema: { type: "string" as const },
    })),
    {
      name: "values",
      description:
        "Two-dimensional string/number cell matrix for update_sheet.",
      required: false,
      schema: { type: "array", items: { type: "object" } },
    },
  ],
  handler: async (runtime, message, _state?: State, options?: HandlerOptions) =>
    handleGoogleWorkspace(runtime, message, options),
};
