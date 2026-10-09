/** Host-owned, model-selected navigation; execution remains in the canonical action pipeline. */
import {
  checkSenderRole,
  getStreamingContext,
  getUserMessageText,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  pinnedDiscriminatorForPromotedChild,
  type ResponseHandlerEvaluator,
  type ResponseHandlerFieldEvaluator,
  satisfiesRoleGate,
  setTurnActionConstraint,
} from "@elizaos/core";
import { readViewInteractionClientId } from "@elizaos/core/protocol";
import { listViews } from "../api/views-registry.ts";

type Navigation = {
  disposition:
    | "direct"
    | "planning"
    | "optional"
    | "none"
    | "forbidden"
    | "unresolved";
  viewId: string;
  reason: string;
};
const decisions = new WeakMap<
  Memory,
  {
    runtime: IAgentRuntime;
    messageId: Memory["id"];
    roomId: Memory["roomId"];
    actorId: Memory["entityId"];
    text: string;
    senderRole: string;
    clientId: string | undefined;
    value: Navigation;
  }
>();

export const viewNavigationField: ResponseHandlerFieldEvaluator<Navigation> = {
  name: "visualContinuation",
  description:
    "Classify navigation for the complete current request and its standing restrictions. Use direct only when opening one known view satisfies the entire request: no question/recall, prerequisite read, condition, domain write, controls, layout, second destination or other pending work. Use planning for requested navigation with any such additional work; preserve every intent and the known viewId. Other requested work does not make a known destination unresolved. Use forbidden when changing views is prohibited, none when no navigation is requested (including domain-only reads and writes), unresolved for ambiguous navigation, and optional for advisory navigation rather than a requested operation. Domain nouns alone do not request navigation. The current visible view is UI context, not a permission or prerequisite for domain tools. Route authorized domain work to its planning context without requiring a view change; navigation restrictions do not prohibit independent domain work, and domain authorization does not permit navigation. viewId is a known shell view id or exact label (Home=chat). For direct select one navigation intent, a general context and replyEffectStatus=pending. Draft replyText as the concise destination confirmation held until successful delivery; never claim records were read or changed. Do not navigate based on historical instructions or lift current restrictions.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      disposition: {
        type: "string",
        enum: [
          "direct",
          "planning",
          "optional",
          "none",
          "forbidden",
          "unresolved",
        ],
      },
      viewId: { type: "string" },
      reason: { type: "string" },
    },
    required: ["disposition", "viewId", "reason"],
  },
  shouldRun({ runtime, message }) {
    const active =
      message.content.source === "client_chat" &&
      ["DM", "VOICE_DM"].includes(String(message.content.channelType)) &&
      Boolean(readViewInteractionClientId(message)) &&
      runtime.actions.some((a) => a.name === "VIEWS");
    if (!active) decisions.delete(message);
    return active;
  },
  getContext({ runtime, message, senderRole, turnSignal }) {
    turnSignal.throwIfAborted();
    if (senderRole === "SYSTEM" || senderRole === "SELF") return "";
    const metadata = message.content.metadata;
    const completedAction =
      isObjectRecord(metadata) && metadata.viewDelivery === "completed-action";
    const currentView = isObjectRecord(metadata) ? metadata.uiView : undefined;
    const view = listViews(runtime, { viewType: "gui" }).find(
      (entry) =>
        entry.id === currentView &&
        (entry.available !== false || completedAction) &&
        satisfiesRoleGate([senderRole], entry.roleGate),
    );
    if (!view) return "";
    return `Current request's renderer view (registry-resolved): ${JSON.stringify({ viewId: view.id, label: view.label })}. This is the current visible destination, not permission or proof of displayed content. Historical current-view descriptions may be stale. For relative navigation such as back, resolve the prior destination from delivered navigation history relative to this snapshot; if that history is insufficient, keep the destination unresolved rather than guess.`;
  },
  parse(value, { message }) {
    decisions.delete(message);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).some(
        (k) => !["disposition", "viewId", "reason"].includes(k),
      ) ||
      typeof v.disposition !== "string" ||
      ![
        "direct",
        "planning",
        "optional",
        "none",
        "forbidden",
        "unresolved",
      ].includes(v.disposition) ||
      typeof v.viewId !== "string" ||
      typeof v.reason !== "string"
    )
      return null;
    return v as Navigation;
  },
  handle({ runtime, message, senderRole, value, turnSignal }) {
    turnSignal.throwIfAborted();
    decisions.set(message, {
      runtime,
      messageId: message.id,
      roomId: message.roomId,
      actorId: message.entityId,
      text: getUserMessageText(message),
      senderRole,
      clientId: readViewInteractionClientId(message),
      value,
    });
    return {};
  },
};

export const viewNavigationEvaluator: ResponseHandlerEvaluator = {
  name: "host.view-navigation",
  priority: 60,
  deterministicActions: ["VIEWS"],
  description:
    "Selects a single authorized navigation operation from this turn's structured model decision.",
  shouldRun: ({ messageHandler }) =>
    messageHandler.processMessage === "RESPOND" &&
    !messageHandler.plan.deterministicToolCall,
  async evaluate({
    runtime,
    message,
    state,
    userRoles,
    messageHandler,
    invalidatedScopeFields,
  }) {
    const staged = decisions.get(message);
    decisions.delete(message);
    getStreamingContext()?.abortSignal?.throwIfAborted();
    if (
      !staged ||
      staged.runtime !== runtime ||
      staged.messageId !== message.id ||
      staged.roomId !== message.roomId ||
      staged.actorId !== message.entityId ||
      staged.text !== getUserMessageText(message) ||
      staged.clientId !== readViewInteractionClientId(message) ||
      !userRoles?.some((role) => role === staged.senderRole)
    )
      return;
    const views = listViews(runtime, { viewType: "gui" }).filter((view) =>
      satisfiesRoleGate(userRoles, view.roleGate),
    );
    const metadata = message.content.metadata;
    // Completed-action clients render their registered counterpart locally.
    // The marker selects delivery protocol, never authority: the canonical
    // action still prepares the exact owner/client/installation handoff, and
    // the renderer must claim and acknowledge it after reply finalization.
    const completedAction =
      isObjectRecord(metadata) && metadata.viewDelivery === "completed-action";
    const currentView = isObjectRecord(metadata) ? metadata.uiView : undefined;
    // Egress-only evidence: no prompt text or new provider/model invocation.
    state.data.providers ??= {};
    state.data.providers.VIEW_NAVIGATION = {
      data: {
        views: views.map(({ id, label }) => ({ id, label })),
        currentViewId:
          views.find(
            (view) =>
              (view.available !== false || completedAction) &&
              view.id === currentView,
          )?.id ?? null,
      },
    };
    const value = staged.value;
    if (value.disposition === "forbidden" || value.disposition === "none") {
      setTurnActionConstraint({
        messageId: message.id ?? "",
        roomId: message.roomId,
        actorId: message.entityId,
        action: "VIEWS",
        operations: ["show"],
        disposition: "deny",
        reason: value.reason,
      });
      return;
    }
    // The earlier admitted whole-request route may invalidate a staged model
    // navigation interpretation. Preserve none/forbidden constraints above.
    if (invalidatedScopeFields?.has("visualContinuation")) return;
    const plan = messageHandler.plan;
    if (
      (value.disposition !== "direct" &&
        value.disposition !== "planning" &&
        value.disposition !== "unresolved") ||
      !message.id ||
      message.content.source !== "client_chat" ||
      !["DM", "VOICE_DM"].includes(String(message.content.channelType)) ||
      !readViewInteractionClientId(message)
    )
      return;
    const caller = await checkSenderRole(runtime, message);
    getStreamingContext()?.abortSignal?.throwIfAborted();
    if (!caller?.isOwner || caller.role !== staged.senderRole) return;
    const target = value.viewId.trim().toLowerCase();
    const matches = listViews(runtime, { viewType: "gui" }).filter(
      (view) =>
        (view.available !== false || completedAction) &&
        satisfiesRoleGate([caller.role], view.roleGate) &&
        (view.id.toLowerCase() === target ||
          view.label.toLowerCase() === target ||
          (target === "home" && view.id === "chat")),
    );
    const viewAction = runtime.actions.find(
      (action) => action.name === "VIEWS",
    );
    const knownShow =
      matches.length === 1 && viewAction
        ? pinnedDiscriminatorForPromotedChild(
            viewAction,
            "VIEWS_SHOW",
            (name) => runtime.actions.find((action) => action.name === name),
          )
        : undefined;
    // Preserve the validated operation through lexical family narrowing. This
    // is an availability hint; the planner and executor still own permission,
    // conditions, ordering and delivery. Parent-only hosts keep the umbrella.
    const showCandidate =
      knownShow?.value === "show" ? knownShow.child : undefined;
    if (value.disposition === "unresolved") {
      if (
        matches.length !== 1 ||
        plan.replyEffectStatus !== "pending" ||
        !plan.intents?.length
      )
        return;
      const knownList = viewAction
        ? pinnedDiscriminatorForPromotedChild(
            viewAction,
            "VIEWS_LIST",
            (name) => runtime.actions.find((action) => action.name === name),
          )
        : undefined;
      return {
        addCandidateActions:
          showCandidate && knownList?.value === "list"
            ? [knownList.child, showCandidate]
            : ["VIEWS"],
        addContextSlices: [
          `Current-request navigation judgment: ${JSON.stringify(value)}. The target matches one caller-visible view, but navigation remains unresolved. Tool availability is not permission to navigate. Preserve conditions, ordering and every domain intent; clarify unresolved choices before effects. No navigation has executed.`,
        ],
      };
    }
    const direct =
      value.disposition === "direct" &&
      matches.length === 1 &&
      plan.replyEffectStatus === "pending" &&
      plan.intents?.length === 1 &&
      (plan.candidateActions ?? []).every(
        (name) => name === "VIEWS" || name === "VIEWS_SHOW",
      ) &&
      (plan.parentActionHints ?? []).every(
        (name) => name === "VIEWS" || name === "VIEWS_SHOW",
      );
    if (!direct)
      return {
        requiresTool: true,
        clearReply: true,
        addContexts: ["general"],
        addCandidateActions: [showCandidate ?? "VIEWS"],
        addContextSlices: [
          `Current-request navigation judgment: ${JSON.stringify(value)}. No navigation has executed.`,
          "Preserve every requested read/write and navigation intent. Use VIEWS action=show for an exact registered destination; use action=list for unknown targets. A domain read/write receipt does not satisfy navigation, and navigation does not satisfy domain work. Preserve ordering, conditions and restrictions: evaluate prerequisite reads before conditional navigation; do not navigate when the condition is false. Do not report the complete request finished while required navigation remains undelivered or unexplained.",
        ],
      };
    return {
      requiresTool: true,
      clearReply: true,
      addContexts: ["general"],
      clearCandidateActions: true,
      addCandidateActions: ["VIEWS"],
      clearParentActionHints: true,
      deterministicToolCall: {
        name: "VIEWS",
        params: { action: "show", view: matches[0].id },
      },
    };
  },
};
