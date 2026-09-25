/** Host-owned navigation through the existing caller-scoped view registry and HTTP delivery route. */
import { randomUUID } from "node:crypto";
import {
  type Action,
  type ActionResult,
  checkSenderRole,
  getStreamingContext,
  getTurnActionConstraint,
  isObjectRecord,
  satisfiesRoleGate,
} from "@elizaos/core";
import {
  createSelfApiRequestHeaders,
  firstWinningEnvString,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
} from "@elizaos/core/runtime-env";
import { readViewInteractionClientId } from "@elizaos/core/views/view-interact-protocol";
import { listViews } from "../api/views-registry.ts";

export const viewsAction: Action = {
  name: "VIEWS",
  similes: ["VIEWS_SHOW", "OPEN_VIEW", "NAVIGATE_VIEW", "VIEWS_LIST"],
  description:
    "List registered application views or show an exact view id/label (for example Home, Notes, Calendar). Navigation only: opening a view does not read or change its records. Does not create or edit apps.",
  contexts: ["general", "notes", "calendar", "settings"],
  roleGate: { minRole: "OWNER" },
  parameters: [
    {
      name: "action",
      description: "list or show",
      required: true,
      schema: { type: "string", enum: ["list", "show"] },
    },
    {
      name: "view",
      description:
        "Exact registered view id or label; home opens the chat/home screen. Required for show.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "navigationStepId",
      description:
        "Optional runtime-owned navigation correlation. The executor supplies it; omit when planning.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    const fail = (status: string, reason: string): ActionResult => ({
      success: false,
      text: reason,
      turnComplete: false,
      data: {
        navigation: {
          effect: "view_navigation",
          status,
          viewId: null,
          stepId: null,
          reason,
        },
      },
    });
    // The loopback credential is host authority. Recheck actor authorization
    // before using it; tool parameters and viewClientId grant no permissions.
    const caller = await checkSenderRole(runtime, message);
    if (!caller?.isOwner)
      return fail(
        "forbidden",
        "Only the authorized owner may navigate this shell.",
      );
    const signal = getStreamingContext()?.abortSignal;
    if (signal?.aborted) return fail("cancelled", "Navigation was cancelled.");
    const constraint = getTurnActionConstraint(
      {
        messageId: message.id ?? "",
        roomId: message.roomId,
        actorId: message.entityId,
        action: "VIEWS",
      },
      "show",
    );
    if (constraint?.disposition === "deny")
      return fail("forbidden", constraint.reason);
    const params = options?.parameters;
    if (!isObjectRecord(params))
      return fail(
        "invalid",
        "Use action=list or action=show with a registered view.",
      );
    const views = listViews(runtime, { viewType: "gui" }).filter((view) =>
      satisfiesRoleGate([caller.role], view.roleGate),
    );
    if (params.action === "list")
      return {
        success: true,
        text: JSON.stringify(
          views.map(({ id, label, path }) => ({ id, label, path })),
        ),
        data: { views },
      };
    if (params.action !== "show" || typeof params.view !== "string")
      return fail(
        "invalid",
        "Use action=show with a registered view id or label.",
      );
    const target = params.view.trim().toLowerCase();
    const matches = views.filter(
      (view) =>
        view.id.toLowerCase() === target ||
        view.label.toLowerCase() === target ||
        (target === "home" && view.id === "chat"),
    );
    if (matches.length !== 1)
      return fail(
        matches.length ? "ambiguous" : "not-found",
        "No unique registered view matches. Use VIEWS action=list to inspect available views.",
      );
    const view = matches[0];
    const clientId = readViewInteractionClientId(message);
    if (!clientId)
      return fail(
        "unavailable",
        "No originating renderer is bound to this turn.",
      );
    const handoffId = randomUUID();
    const delivery = "originating-client";
    const port = firstWinningEnvString(process.env, ["ELIZA_API_PORT"])
      ? resolveDesktopApiPort(process.env)
      : resolveServerOnlyPort(process.env);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/views/${encodeURIComponent(view.id)}/navigate`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            ...createSelfApiRequestHeaders(),
          },
          body: JSON.stringify({
            clientId,
            delivery,
            completedActionHandoffId: handoffId,
            viewType: "gui",
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
        },
      );
      if (!response.ok)
        return fail(
          response.status === 403 ? "forbidden" : "not-delivered",
          `Navigation route rejected delivery (HTTP ${response.status}).`,
        );
      const body: unknown = await response.json();
      if (
        !isObjectRecord(body) ||
        body.ok !== true ||
        body.viewId !== view.id ||
        body.completedActionHandoffId !== handoffId ||
        body.completedActionDelivered !== true
      )
        return fail(
          "not-delivered",
          "The originating renderer did not acknowledge navigation delivery.",
        );
      if (signal?.aborted)
        return fail(
          "cancelled",
          "Navigation was cancelled before confirmation.",
        );
      const receipt = {
        effect: "view_navigation",
        status: "delivered",
        viewId: view.id,
        path: view.path,
        label: view.label,
        stepId:
          typeof params.navigationStepId === "string"
            ? params.navigationStepId
            : null,
        handoffId,
      };
      return {
        success: true,
        text: JSON.stringify(receipt),
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        values: {
          mode: "show",
          viewId: view.id,
          viewPath: view.path,
          viewType: "gui",
          label: view.label,
          completedActionDelivered: true,
          completedActionHandoffId: handoffId,
        },
        data: {
          view,
          navigation: receipt,
        },
      };
    } catch (error) {
      if (signal?.aborted)
        return fail("cancelled", "Navigation was cancelled.");
      runtime.reportError("VIEWS.delivery", error, { viewId: view.id });
      return fail(
        "transport-error",
        "Navigation transport failed; no successful delivery was confirmed.",
      );
    }
  },
};
