/**
 * Authenticated state boundary for managed Cloud Notes. Mutations use
 * the shared view-capability broker so direct controls and agent actions cannot
 * drift into parallel transport contracts.
 */

import { isElizaError, type Route, toElizaError } from "@elizaos/core";
import { getNotesService } from "./service.js";

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
];
