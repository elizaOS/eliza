/**
 * Authenticated state boundary for managed Notes. Recoverable edits use the
 * view broker. Permanent Trash erase is an explicit owner route.
 */

import { isElizaError, toElizaError } from "@elizaos/core";
import type { Route, RouteHandlerContext } from "@elizaos/host/protocol";
import { getNotesService, type NotesService } from "./service.js";

function ownerTrashRoute(
  type: "GET" | "POST",
  path: string,
  handle: (
    service: NotesService,
    context: RouteHandlerContext,
  ) => Promise<unknown>,
): Route {
  return {
    type,
    name: path,
    path,
    rawPath: true,
    ...(type === "POST" ? { maxBodyBytes: 1024 } : {}),
    modes: ["local", "local-only"],
    modeReason:
      "Permanent Trash operations require an opted-in local Notes host",
    routeHandler: async (context) => {
      if (!context.accessContext?.isOwner)
        return {
          status: 403,
          body: { success: false, error: { code: "NOTES_OWNER_REQUIRED" } },
        };
      try {
        const data = await handle(getNotesService(context.runtime), context);
        return { status: 200, body: { success: true, data } };
      } catch (error) {
        // error-policy:J1 boundary translation — preserve typed refusal at the owner API.
        if (context.signal.aborted && error === context.signal.reason)
          return {
            status: 499,
            body: {
              success: false,
              error: { code: "NOTES_REQUEST_CANCELLED" },
            },
          };
        const failure = isElizaError(error)
          ? error
          : toElizaError(error, "NOTES_ROUTE_FAILED");
        const status =
          {
            NOTES_VALIDATION_FAILED: 400,
            NOTES_NOT_FOUND: 404,
            NOTES_TRASH_RETENTION_DISABLED: 404,
            NOTES_EDIT_CONFLICT: 409,
            NOTES_TRASH_RECORDING_UNAVAILABLE: 409,
            NOTES_SERVICE_UNAVAILABLE: 503,
            NOTES_STORE_UNAVAILABLE: 503,
          }[failure.code] ?? 500;
        if (status >= 500)
          context.runtime.reportError("NotesTrashRoutes", failure, { path });
        return {
          status,
          body: {
            success: false,
            error: { code: failure.code, message: failure.message },
          },
        };
      }
    },
  };
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
            data: context.accessContext?.isOwner
              ? await getNotesService(context.runtime).readSnapshot(
                  context.signal,
                )
              : getNotesService(context.runtime).snapshot(),
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
  ownerTrashRoute(
    "POST",
    "/api/notes/trash/erase",
    async (service, context) => {
      const { value, snapshot } = await service.eraseTrash(
        context.body,
        context.signal,
      );
      return { ...value, state: snapshot };
    },
  ),
  ownerTrashRoute("GET", "/api/notes/trash/recordings", (service, context) =>
    service.readTrashRecordingCleanup(context.signal),
  ),
  ownerTrashRoute(
    "POST",
    "/api/notes/trash/recordings/complete",
    async (service, context) => ({
      acknowledged: await service.acknowledgeTrashRecordingCleanup(
        context.body,
        context.signal,
      ),
    }),
  ),
];
