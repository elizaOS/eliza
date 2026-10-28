/** Host-owned navigation through the existing caller-scoped view registry and HTTP delivery route. */
import { randomUUID } from "node:crypto";
import {
  type Action,
  type ActionResult,
  checkSenderRole,
  getStreamingContext,
  getTurnActionConstraint,
  type IAgentRuntime,
  isObjectRecord,
  satisfiesRoleGate,
} from "@elizaos/core";
import { readViewInteractionClientId } from "@elizaos/core/protocol";
import {
  createSelfApiRequestHeaders,
  resolveSelfApiBaseUrl,
} from "@elizaos/host/protocol";
import { dispatchApiRoute } from "../api/in-process-api.ts";
import { listViews, type ViewRegistryEntry } from "../api/views-registry.ts";
import { getViewClientScope } from "../runtime/view-client-context.ts";
import {
  resolveViewNavigationTargets,
  viewNavigationAvailable,
} from "../runtime/view-navigation-targets.ts";

export interface ViewNavigationDelivery {
  runtime: IAgentRuntime;
  view: ViewRegistryEntry;
  clientId: string;
  handoffId: string;
  completedAction: boolean;
  delivery: "completed-action" | "originating-client";
  resolvedAlias?: string;
  apiBase: string;
  signal?: AbortSignal;
  isAuthorized: () => boolean;
}
export type DeliverViewNavigation = (
  input: ViewNavigationDelivery,
) => Promise<{ status: number; body: unknown }>;

/** Default delivery retains the host's authenticated in-process/HTTP boundary. */
async function deliverViewNavigation({
  runtime,
  view,
  clientId,
  handoffId,
  completedAction,
  delivery,
  resolvedAlias,
  apiBase,
  signal,
  isAuthorized,
}: ViewNavigationDelivery): Promise<{ status: number; body: unknown }> {
  const path = `/api/views/${encodeURIComponent(view.id)}/navigate`;
  const requestBody = {
    clientId,
    delivery,
    completedActionHandoffId: handoffId,
    viewType: "gui",
    ...(resolvedAlias ? { resolvedAlias } : {}),
    ...(completedAction ? { prepareOnly: true } : {}),
  };
  let status: number;
  let body: unknown;
  const scope = getViewClientScope();
  // Cost: the same owned kernel, no loopback RPC or root-credential identity change.
  // An expired scoped request fails closed in the dispatcher; it never falls back.
  if (
    scope?.request ||
    process.env.ELIZA_LOCAL_AGENT_TRANSPORT === "filesystem-v1"
  ) {
    const response = await dispatchApiRoute({
      runtime,
      inProcess: true,
      ...(scope?.request ? { hostKey: scope.hostKey } : {}),
      isAuthorized,
      method: "POST",
      path,
      headers: {
        "Content-Type": "application/json",
        ...(scope?.request ? {} : createSelfApiRequestHeaders()),
      },
      body: requestBody,
      signal,
    });
    status = response.status;
    body = response.body;
  } else {
    const response = await fetch(`${apiBase}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...createSelfApiRequestHeaders(),
      },
      body: JSON.stringify(requestBody),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    status = response.status;
    body = status >= 200 && status < 300 ? await response.json() : undefined;
  }
  return { status, body };
}

/** Hosts may provide delivery without replacing owner, registry or receipt checks.
 * A preparation-only host must return the same exact prepared binding; this
 * action never treats preparation as confirmation that navigation occurred. */
export function createViewsAction(
  deliver: DeliverViewNavigation = deliverViewNavigation,
): Action {
  return {
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
        requiredForSubactions: ["show"],
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
    handler: async (
      runtime,
      message,
      _state,
      options,
    ): Promise<ActionResult> => {
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
      if (signal?.aborted)
        return fail("cancelled", "Navigation was cancelled.");
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
      if (params.action !== "show" || typeof params.view !== "string")
        return fail(
          "invalid",
          "Use action=show with a registered view id or label.",
        );
      const target = params.view.trim().toLowerCase();
      const matches = resolveViewNavigationTargets(views, target);
      if (matches.length !== 1)
        return fail(
          matches.length ? "ambiguous" : "not-found",
          "No unique registered view matches. Use VIEWS action=list to inspect available views.",
        );
      const { view, resolvedAlias } = matches[0];
      const clientId = readViewInteractionClientId(message);
      if (!clientId)
        return fail(
          "unavailable",
          "No originating renderer is bound to this turn.",
        );
      const handoffId = randomUUID();
      const completedAction =
        isObjectRecord(message.content.metadata) &&
        message.content.metadata.viewDelivery === "completed-action";
      if (!viewNavigationAvailable(view, completedAction))
        return fail(
          "unavailable",
          "This destination has no available hosted view for the originating renderer.",
        );
      const delivery = completedAction
        ? "completed-action"
        : "originating-client";
      const apiBase = resolveSelfApiBaseUrl(process.env);
      try {
        const { status, body } = await deliver({
          runtime,
          view,
          clientId,
          handoffId,
          completedAction,
          delivery,
          resolvedAlias,
          apiBase,
          signal,
          isAuthorized: () => caller.isOwner,
        });
        if (status < 200 || status >= 300)
          return fail(
            status === 403 ? "forbidden" : "not-delivered",
            `Navigation route rejected delivery (HTTP ${status}).`,
          );
        if (
          !isObjectRecord(body) ||
          body.ok !== true ||
          body.viewId !== view.id ||
          body.completedActionHandoffId !== handoffId ||
          (completedAction
            ? body.status !== "prepared"
            : body.completedActionDelivered !== true)
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
        const navigationBinding = {
          requestId: handoffId,
          clientId,
          viewId: view.id,
          viewType: "gui",
          installationId: view.installationId,
        };
        const returnedBinding = body.navigationBinding;
        if (
          completedAction &&
          (!isObjectRecord(returnedBinding) ||
            Object.entries(navigationBinding).some(
              ([key, value]) => returnedBinding[key] !== value,
            ))
        )
          return fail(
            "not-delivered",
            "Navigation preparation did not retain its exact renderer binding.",
          );
        const receipt = {
          effect: "view_navigation",
          status: completedAction ? "prepared" : "delivered",
          viewId: view.id,
          path: view.path,
          label: view.label,
          // Carry only an alias that this action resolved to this authorized
          // installed view; reply validation must not guess consumer branding.
          ...(resolvedAlias ? { resolvedAlias } : {}),
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
          // Delivery receipts own the effect; the model owns conversational wording.
          modelReplyRequired: true,
          values: {
            mode: "show",
            viewId: view.id,
            viewPath: view.path,
            viewType: "gui",
            label: view.label,
            completedActionDelivered: !completedAction,
            completedActionHandoffId: handoffId,
            ...(completedAction
              ? {
                  navigationPrepared: true,
                  navigationBinding,
                }
              : {}),
          },
          data: {
            ...(completedAction ? { awaitingDeviceExecution: true } : {}),
            view,
            navigation: receipt,
          },
          // The canonical result retains the registry entry. Model history needs
          // delivery proof; full capability grammar remains an explicit, freshly
          // authorized registry read. This projection adds no I/O or model call.
          promptDataMode: "replace-data",
          promptData: {
            navigation: receipt,
            viewDetails:
              "Call VIEWS_LIST (or VIEWS action=list) for complete registered view definitions and capabilities. This lookup does not navigate.",
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
}

export const viewsAction = createViewsAction();
