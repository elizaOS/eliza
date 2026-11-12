/**
 * Authenticated state boundary for managed Cloud Notes. Mutations use
 * the shared view-capability broker so direct controls and agent actions cannot
 * drift into parallel transport contracts. Permanent deletion is a direct
 * owner operation and is unavailable to agent view capabilities.
 */

import {
  isElizaError,
  resolveOwnerEntityIdOrDefault,
  toElizaError,
} from "@elizaos/core";
import type { Route, RouteHandlerContext } from "@elizaos/host/protocol";
import { getNotesService } from "./service.js";
import { parseNotesArchiveEraseInput } from "./validation.js";

const eraseConflicts = new Set([
  "NOTES_EDIT_CONFLICT",
  "NOTES_ERASE_PENDING",
  "NOTES_ERASE_RECORDING_REQUIRED",
  "NOTES_ERASE_RECEIPT_MISMATCH",
]);

function isNotesOwner(context: RouteHandlerContext): boolean {
  const access = context.accessContext;
  if (!access) return context.isTrustedLocal === true;
  return (
    access.role === "OWNER" &&
    access.isOwner === true &&
    access.requesterEntityId === resolveOwnerEntityIdOrDefault(context.runtime)
  );
}

export const notesRoutes: Route[] = [
  {
    type: "GET",
    name: "notes-state",
    path: "/api/notes/state",
    rawPath: true,
    modes: ["local", "local-only", "cloud", "remote"],
    modeReason:
      "Notes state is owned by the active runtime in every supported topology",
    routeHandler: async (context) => {
      try {
        return {
          status: 200,
          body: {
            success: true,
            data: await getNotesService(context.runtime).snapshot(),
          },
        };
      } catch (error) {
        // error-policy:J1 boundary translation — this authenticated HTTP boundary
        // reports systemic failures and never fabricates an empty state document.
        const normalized = isElizaError(error)
          ? error
          : toElizaError(error, "NOTES_ROUTE_FAILED");
        context.runtime.reportError("NotesRoutes", normalized, {
          method: context.method,
          path: context.path,
        });
        return {
          status:
            normalized.code === "NOTES_SERVICE_UNAVAILABLE" ||
            normalized.code === "NOTES_STORE_UNAVAILABLE"
              ? 503
              : 500,
          body: {
            success: false,
            error: { code: normalized.code, message: normalized.message },
          },
        };
      }
    },
  },
  {
    type: "POST",
    name: "notes-archive-erase",
    path: "/api/notes/trash/erase",
    rawPath: true,
    modes: ["local", "local-only", "cloud", "remote"],
    modeReason: "The Notes owner can erase records from the active runtime",
    maxBodyBytes: 2048,
    routeHandler: async (context) => {
      if (!isNotesOwner(context))
        return {
          status: 403,
          body: { success: false, error: { code: "NOTES_OWNER_REQUIRED" } },
        };
      context.signal.throwIfAborted();
      try {
        const input = parseNotesArchiveEraseInput(context.body);
        const service = getNotesService(context.runtime);
        const result =
          input.phase === "begin"
            ? await service.beginArchivedNoteErase(
                input.id,
                input.expectedRevision,
                input.operationId,
                input.audioId,
              )
            : await service.finishArchivedNoteErase({
                noteId: input.id,
                operationId: input.operationId,
                audioId: input.audioId,
                status: input.status,
              });
        return { status: 200, body: { success: true, data: result.snapshot } };
      } catch (error) {
        const normalized = isElizaError(error)
          ? error
          : toElizaError(error, "NOTES_ROUTE_FAILED");
        const status = eraseConflicts.has(normalized.code)
          ? 409
          : normalized.code === "NOTES_NOT_FOUND"
            ? 404
            : normalized.code === "NOTES_VALIDATION_FAILED" ||
                normalized.code === "NOTES_EDIT_REVISION_REQUIRED"
              ? 400
              : normalized.code === "NOTES_SERVICE_UNAVAILABLE" ||
                  normalized.code === "NOTES_STORE_UNAVAILABLE"
                ? 503
                : 500;
        if (status >= 500)
          context.runtime.reportError("NotesRoutes", normalized, {
            method: context.method,
            path: context.path,
          });
        return {
          status,
          body: { success: false, error: { code: normalized.code } },
        };
      }
    },
  },
];
