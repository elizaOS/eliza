/** Host-owned, model-selected navigation; execution remains in the canonical action pipeline. */
import {
  checkSenderRole,
  containsResourceAddress,
  getStreamingContext,
  getTurnActionConstraint,
  getUserMessageText,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  pinnedDiscriminatorForPromotedChild,
  type ResponseHandlerEvaluator,
  type ResponseHandlerFieldEvaluator,
  registerDirectActionRoutingRule,
  registerViewNavigationTargetResolver,
  satisfiesRoleGate,
  setTurnActionConstraint,
} from "@elizaos/core";
import { readViewInteractionClientId } from "@elizaos/core/protocol";
import { enabledDeviceViews } from "../actions/views.ts";
import { resolveHostSessionAccessContext } from "../api/host-session-access-context.ts";
import { listViews } from "../api/views-registry.ts";
import { getCurrentViewState } from "../api/views-routes.ts";
import { getViewClientScope } from "./view-client-context.ts";
import {
  isExplicitBackViewRequest,
  isForegroundPageHistoryRequest,
  namesRegisteredView,
  resolveCompoundRegisteredViewRequest,
  resolveExplicitRegisteredViewRequest,
  resolveViewNavigationTargets,
  viewEnabledByProfile,
  viewNavigationAvailable,
  viewNavigationDestination,
} from "./view-navigation-targets.ts";

/** The foreground view when it keeps its own page history (a browser's tabs):
 * a bare Back there means that page history, not the previous app view. */
function foregroundPageHistoryView(
  message: Memory | undefined,
  views: ReturnType<typeof listViews>,
) {
  const metadata = message?.content.metadata;
  const currentView = isObjectRecord(metadata) ? metadata.uiView : undefined;
  return views.find((entry) => entry.id === currentView && entry.pageHistory);
}

/** Travel or place wording beyond naming Maps itself ("go to maps" stays a view switch). */
const MAPS_PLACE_WORDING =
  /\b(?:to|from|near|nearest|closest|nearby|around|directions?|route)\b/iu;
function isMapsPlaceRequest(
  viewId: string,
  text: string,
  views: ReturnType<typeof listViews>,
): boolean {
  if (viewId !== "maps") return false;
  if (resolveExplicitRegisteredViewRequest(views, text)) return false;
  const stripped = text.replace(/\bto\s+(?:the\s+|my\s+)?maps?\b/giu, "");
  return MAPS_PLACE_WORDING.test(stripped);
}

/** Read only acknowledged history from this active transport owner and renderer. */
function confirmedPreviousView(
  runtime: IAgentRuntime,
  message: Memory,
  views: ReturnType<typeof listViews>,
  completedAction: boolean,
) {
  const currentView = isObjectRecord(message.content.metadata)
    ? message.content.metadata.uiView
    : undefined;
  const view = views.find(
    (entry) =>
      entry.id === currentView &&
      viewNavigationAvailable(entry, completedAction),
  );
  if (!view) return;
  const scope = getViewClientScope();
  const request = scope?.request;
  const authorization =
    request?.runtime === runtime && !request.signal.aborted
      ? request.authorization
      : undefined;
  // The HTTP principal and conversation entity need not be the same ID.
  // Use the same verified owner identity as the navigation acknowledgement.
  const ownerId =
    authorization?.ok && authorization.role === "OWNER"
      ? (authorization.identityId ??
        authorization.principal ??
        resolveHostSessionAccessContext(authorization, runtime)
          ?.requesterEntityId)
      : undefined;
  const confirmed =
    ownerId && scope?.clientId === readViewInteractionClientId(message)
      ? getCurrentViewState(runtime, scope)
      : null;
  const confirmation = confirmed?.navigationConfirmation;
  const prior = confirmation?.previousView;
  const previous =
    confirmed?.viewId === view.id &&
    confirmation?.ownerId === ownerId &&
    confirmation?.installationId === view.installationId &&
    prior
      ? views.find(
          (entry) =>
            entry.id === prior.viewId &&
            entry.installationId === prior.installationId &&
            viewNavigationAvailable(entry, completedAction),
        )
      : undefined;
  if (!previous) return;
  const resolvedAlias =
    typeof prior?.resolvedAlias === "string"
      ? resolveViewNavigationTargets([previous], prior.resolvedAlias)[0]
          ?.resolvedAlias
      : undefined;
  return { view: previous, resolvedAlias };
}

/** Add an availability hint for explicit known navigation, never an execution override. */
export function registerViewNavigationRoutingRule(
  runtime: IAgentRuntime,
): void {
  // Plugin routes for places ("take me to Coit Tower") consult this so a view
  // name ("take me to settings") stays view navigation.
  registerViewNavigationTargetResolver(runtime, (target) =>
    namesRegisteredView(
      listViews(runtime, { viewType: "gui", includeAllKinds: true }),
      target,
    ),
  );
  registerDirectActionRoutingRule(runtime, {
    id: "views.explicit-navigation",
    actionNames: ["VIEWS_SHOW"],
    requiredActionTags: [],
    contexts: ["general"],
    matches(text, message) {
      if (
        message &&
        (message.content.source !== "client_chat" ||
          !["DM", "VOICE_DM"].includes(String(message.content.channelType)) ||
          !readViewInteractionClientId(message))
      )
        return false;
      const metadata = message?.content.metadata;
      const completedAction =
        isObjectRecord(metadata) &&
        metadata.viewDelivery === "completed-action";
      const enabled = enabledDeviceViews(runtime);
      const views = listViews(runtime, { viewType: "gui" }).filter(
        (view) =>
          viewNavigationAvailable(view, completedAction) &&
          viewEnabledByProfile(view, enabled),
      );
      return (
        resolveExplicitRegisteredViewRequest(views, text) !== undefined ||
        (Boolean(message) &&
          isExplicitBackViewRequest(text) &&
          !foregroundPageHistoryView(message, views) &&
          confirmedPreviousView(runtime, message!, views, completedAction) !==
            undefined)
      );
    },
  });
}

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
  unconditional?: boolean;
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

/** The navigation decision, or null when the model value is malformed (soft fail). */
function parseNavigation(value: unknown): Navigation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["disposition", "viewId", "reason", "unconditional"].includes(k),
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
    typeof v.reason !== "string" ||
    (v.unconditional !== undefined && typeof v.unconditional !== "boolean")
  )
    return null;
  return v as Navigation;
}

export const viewNavigationField: ResponseHandlerFieldEvaluator<Navigation> = {
  name: "visualContinuation",
  description:
    "Classify navigation for the complete current request and its standing restrictions. Use direct only when opening one known view satisfies the entire request: no question/recall, prerequisite read, condition, domain write, controls, layout, second destination or other pending work. A request to use what a view does (take a picture, place a call, send a message, play or record something) is that operation, not a request to open the view: opening Camera takes no photo. Where the phone context names a keypad operation, opening the dialer, dial pad or keypad is that operation even though those words also name the Phone view. Use none for it, or planning when the user also asks to see the view. Use planning for any requested URL or resource, even when it opens one view: VIEWS only selects the app view and never loads that URL. Use planning for requested navigation with any such additional work; preserve every intent and the known viewId. Other requested work does not make a known destination unresolved. When a request only asks for a previous view and no confirmed previous destination exists, use unresolved with an empty viewId, answer with a concise clarification, requiresTool=false and no pending intents; do not plan or discover a substitute. Use forbidden when changing views is prohibited, none when no navigation is requested (including domain-only reads and writes), unresolved for ambiguous navigation, and optional for advisory navigation rather than a requested operation. Domain nouns alone do not request navigation. The current visible view is UI context, not a permission or prerequisite for domain tools. Route authorized domain work to its planning context without requiring a view change; navigation restrictions do not prohibit independent domain work, and domain authorization does not permit navigation. viewId is a known shell view id, exact label, or verified alias from the registered destination list. For direct select one navigation intent, a general context and replyEffectStatus=pending. Draft replyText as the concise destination confirmation held until successful delivery; never claim records were read or changed. Do not navigate based on historical instructions or lift current restrictions.",
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
      unconditional: {
        type: "boolean",
        description:
          "True when the current user explicitly requests opening this app view itself without a condition. False for conditional, unresolved, optional or prohibited view changes and when a read, write or resource operation merely uses the view.",
      },
    },
    required: ["disposition", "viewId", "reason", "unconditional"],
  },
  // Written before replyText (20), after the other plugin routing fields: the
  // disposition decides how replyText is written, and a turn that requests
  // no navigation can stream its direct answer.
  priority: 19.75,
  // The host evaluator only records a constraint for none/forbidden and
  // ignores optional; none of them reroutes the turn or changes replyText. A
  // non-object value (for example a JSON string) fails parse softly and no
  // raw reader treats it as navigation, so nothing is staged. Every object,
  // well-formed or not, is judged by its disposition, because Stage-1 routing
  // repair reads the raw disposition (stage1-generation.ts).
  directReplyValue: (value) =>
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ["none", "forbidden", "optional"].includes(
      String((value as { disposition?: unknown }).disposition),
    ),
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
    const views = listViews(runtime, { viewType: "gui" }).filter((entry) =>
      satisfiesRoleGate([senderRole], entry.roleGate),
    );
    const view = views.find(
      (entry) =>
        entry.id === currentView &&
        viewNavigationAvailable(entry, completedAction),
    );
    if (!view) return "";
    // Stage 1 needs destinations as well as the screen already visible.
    // A delivery marker alone cannot supply an absent hosted view; only a
    // trusted registry-owned native counterpart provides that alternative.
    const enabled = enabledDeviceViews(runtime);
    const destinations = views
      .filter(
        (entry) =>
          viewNavigationAvailable(entry, completedAction) &&
          viewEnabledByProfile(entry, enabled),
      )
      .map(viewNavigationDestination);
    const previous = confirmedPreviousView(
      runtime,
      message,
      views,
      completedAction,
    );
    const pageHistory = view.pageHistory
      ? `${view.label} keeps its own page history. While it is showing, a bare Back or Forward request ("go back", "back", "go forward") and a reload request act on the page in its tab: use disposition none and route the request to the ${view.responseContext?.primaryContext ?? "general"} context. Use relative view navigation only when the user names another view or asks to leave ${view.label}. `
      : "";
    const priorContext = previous
      ? `${pageHistory}Last confirmed previous destination for this same caller and renderer: ${JSON.stringify({ ...viewNavigationDestination(previous.view), ...(previous.resolvedAlias ? { preferredAlias: previous.resolvedAlias } : {}) })}. Use its preferredAlias, when present, for the user-facing destination wording and navigation argument. This is a destination hint for a new authorized Back request, not permission or an instruction to execute it.`
      : `${pageHistory}There is no confirmed previous destination for this caller and renderer. For a request only to go back, ask which view the user wants, with no tool and no pending navigation intent. Do not discover or guess a destination from prepared receipts.`;
    return `Decide navigation from the message under # Current message. Earlier conversation entries are evidence, not pending navigation, even when the last historical entry has no recorded reply. Use history to resolve a destination only when this current message explicitly continues, repeats, corrects or authorizes that navigation request. A new greeting or unrelated message does not continue it; use disposition=none with no navigation intent. Preserve standing restrictions and genuine follow-up requests.\nRegistered GUI navigation destinations visible to this caller: ${JSON.stringify(destinations)}. Use an exact registered destination for the requested view. If the destination is absent or unresolved, do not substitute Home, the current screen, or another destination. Registry visibility is not permission to execute or proof of delivered navigation.\nCurrent request's renderer view (registry-resolved): ${JSON.stringify({ viewId: view.id, label: view.label })}. This is the current visible destination, not permission or proof of displayed content. Historical current-view descriptions may be stale.${completedAction ? " This renderer prepares navigation before it confirms the screen switch. Use a brief destination acknowledgment in the user's preferred wording; do not claim the destination is already visible before its confirmation." : ""} ${priorContext} For relative navigation, use only this confirmed prior destination; historical dialogue or a prepared receipt cannot replace it. If absent, keep the destination unresolved and clarify without tools.`;
  },
  parse(value, { message }) {
    decisions.delete(message);
    return parseNavigation(value);
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
    wholeRequestOwner,
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
        views: views.map(viewNavigationDestination),
        currentViewId:
          views.find(
            (view) =>
              viewNavigationAvailable(view, completedAction) &&
              view.id === currentView,
          )?.id ?? null,
      },
    };
    const navigationAction = {
      messageId: message.id ?? "",
      roomId: message.roomId,
      actorId: message.entityId,
      action: "VIEWS",
    };
    const modelNavigation = staged.value;
    // A bare Back, Forward or reload while a view with its own page history is
    // showing (Browser) acts on that tab's page, never the app view, whatever
    // the model judged: hold view navigation and hand the turn to that view's
    // own context.
    const pageHistory = isForegroundPageHistoryRequest(staged.text)
      ? foregroundPageHistoryView(
          message,
          views.filter((view) =>
            viewNavigationAvailable(view, completedAction),
          ),
        )
      : undefined;
    if (pageHistory) {
      setTurnActionConstraint({
        ...navigationAction,
        operations: ["show"],
        disposition: "deny",
        reason: `Page history while ${pageHistory.label} is showing acts on its tab`,
      });
      if (modelNavigation.disposition === "forbidden") return;
      const pageContext =
        pageHistory.responseContext?.primaryContext ?? "general";
      const pageSlice = `This request (${JSON.stringify(staged.text.trim())}) is Back, Forward or reload while ${pageHistory.label} is showing: it acts on the page in the tab that is showing there (for Back, the previous page in the tab), not on the app view. Use the ${pageHistory.label} page history operation; do not change the app view. No navigation has executed.`;
      // Stage 1 judged no view navigation: still make the page's own
      // operations available rather than leaving the turn to a bare reply.
      if (modelNavigation.disposition === "none")
        return {
          addContexts: [pageContext],
          addContextSlices: [pageSlice],
        };
      return {
        requiresTool: true,
        clearReply: true,
        addContexts: [pageContext],
        clearCandidateActions: true,
        clearParentActionHints: true,
        addContextSlices: [pageSlice],
      };
    }
    const plan = messageHandler.plan;
    const canRoute =
      !invalidatedScopeFields?.has("visualContinuation") &&
      message.id &&
      message.content.source === "client_chat" &&
      ["DM", "VOICE_DM"].includes(String(message.content.channelType)) &&
      staged.clientId;
    const enabled = canRoute ? enabledDeviceViews(runtime) : undefined;
    const senderRoles = userRoles.filter((role) => role === staged.senderRole);
    const availableViews = canRoute
      ? views.filter(
          (view) =>
            viewNavigationAvailable(view, completedAction) &&
            satisfiesRoleGate(senderRoles, view.roleGate) &&
            viewEnabledByProfile(view, enabled),
        )
      : [];
    const modelMatches = resolveViewNavigationTargets(
      availableViews,
      modelNavigation.viewId,
    );
    const viewAction = runtime.actions.find(
      (action) => action.name === "VIEWS",
    );
    const omittedNavigation = modelNavigation.disposition === "none";
    const collapsedNavigation = modelNavigation.disposition === "direct";
    const compound =
      canRoute &&
      !wholeRequestOwner &&
      viewAction &&
      plan.replyEffectStatus === "pending" &&
      (omittedNavigation ||
        collapsedNavigation ||
        (modelNavigation.disposition === "planning" &&
          !modelNavigation.unconditional)) &&
      getTurnActionConstraint(navigationAction, "show")?.disposition !== "deny"
        ? resolveCompoundRegisteredViewRequest(availableViews, staged.text)
        : undefined;
    const agreedCompound =
      compound &&
      ((modelMatches.length === 1 &&
        compound.view.id === modelMatches[0].view.id) ||
        (omittedNavigation && !modelNavigation.viewId.trim()))
        ? compound
        : undefined;
    const caller =
      canRoute &&
      (agreedCompound ||
        collapsedNavigation ||
        modelNavigation.disposition === "planning" ||
        modelNavigation.disposition === "unresolved")
        ? await checkSenderRole(runtime, message)
        : undefined;
    getStreamingContext()?.abortSignal?.throwIfAborted();
    const owner = caller?.isOwner && caller.role === staged.senderRole;
    const compoundNavigation = owner ? agreedCompound : undefined;
    if (
      modelNavigation.disposition === "forbidden" ||
      (omittedNavigation && !compoundNavigation)
    ) {
      setTurnActionConstraint({
        ...navigationAction,
        operations: ["show"],
        disposition: "deny",
        reason: modelNavigation.reason,
      });
      return;
    }
    if (!owner) return;
    const value: Navigation = compoundNavigation
      ? {
          disposition: "planning",
          viewId: compoundNavigation.view.id,
          reason: "The current request names a view and a separate read",
          unconditional: true,
        }
      : modelNavigation;
    const matches = compoundNavigation
      ? [{ view: compoundNavigation.view }]
      : modelMatches;
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
    // "take me to Coit Tower", "nearest pharmacy": Stage 1 may judge a place or
    // route request direct navigation to Maps, which opens Maps with no route.
    const mapsPlace =
      !compoundNavigation &&
      matches.length === 1 &&
      isMapsPlaceRequest(matches[0].view.id, staged.text, availableViews);
    const direct =
      value.disposition === "direct" &&
      // An explicit resource address cannot be fulfilled by view selection.
      // This only declines the shortcut; the normal planner retains authority.
      !containsResourceAddress(staged.text) &&
      !mapsPlace &&
      matches.length === 1 &&
      plan.replyEffectStatus === "pending" &&
      plan.intents?.length === 1 &&
      plan.contexts.length > 0 &&
      plan.contexts.every((context) => context === "general") &&
      // Empty hints are not positive evidence of a navigation-only request.
      // Without an explicit navigation candidate, preserve the planner path.
      [
        ...(plan.candidateActions ?? []),
        ...(plan.parentActionHints ?? []),
      ].some((name) => name === "VIEWS" || name === "VIEWS_SHOW") &&
      (plan.candidateActions ?? []).every(
        (name) => name === "VIEWS" || name === "VIEWS_SHOW",
      ) &&
      (plan.parentActionHints ?? []).every(
        (name) => name === "VIEWS" || name === "VIEWS_SHOW",
      );
    if (!direct) {
      const priorIntents = plan.intents ?? [];
      const destination = matches.length === 1 ? matches[0].view : undefined;
      const requiredViewNavigation =
        destination?.installationId &&
        staged.clientId &&
        viewAction &&
        value.disposition === "planning" &&
        value.unconditional === true
          ? {
              viewId: destination.id,
              clientId: staged.clientId,
              installationId: destination.installationId,
            }
          : undefined;
      return {
        requiresTool: true,
        clearReply: true,
        ...(requiredViewNavigation ? { requiredViewNavigation } : {}),
        ...(compoundNavigation && (omittedNavigation || collapsedNavigation)
          ? {
              replaceIntentScope: {
                intents: omittedNavigation
                  ? [
                      ...priorIntents,
                      `Open the ${compoundNavigation.view.label} view`,
                      ...(!priorIntents.length
                        ? [compoundNavigation.followUp]
                        : []),
                    ]
                  : [...priorIntents, compoundNavigation.followUp],
                invalidateFields: [],
              },
            }
          : {}),
        addContexts: [
          "general",
          ...(mapsPlace && runtime.contexts?.get("maps") ? ["maps"] : []),
          ...(compoundNavigation?.view.responseContext
            ? [
                compoundNavigation.view.responseContext.primaryContext,
                ...(compoundNavigation.view.responseContext.secondaryContexts ??
                  []),
              ]
            : []),
        ],
        addCandidateActions: [showCandidate ?? "VIEWS"],
        addContextSlices: [
          `Current-request navigation judgment: ${JSON.stringify(value)}. No navigation has executed.`,
          ...(mapsPlace
            ? [
                "This request names a place, a destination or a nearby search. Opening the Maps view alone shows no place or route: find the place or plan the route with the Maps operations (MAPS_PLACE, MAPS_ROUTE, MAPS_NAVIGATION_START).",
              ]
            : []),
          "Preserve every requested read/write and navigation intent. Use VIEWS action=show for an exact registered destination; use action=list for unknown targets. A domain read/write receipt does not satisfy navigation, and navigation does not satisfy domain work. VIEWS only selects an app view; loading a requested URL requires the authorized Browser operation and cannot be reported complete from a view-selection receipt. Preserve ordering, conditions and restrictions: evaluate prerequisite reads before conditional navigation; do not navigate when the condition is false. Do not report the complete request finished while required navigation remains undelivered or unexplained.",
        ],
      };
    }
    const requested = resolveExplicitRegisteredViewRequest(
      availableViews,
      staged.text,
    );
    const requestedAlias =
      requested?.view.id === matches[0].view.id
        ? requested.resolvedAlias
        : undefined;
    const prior = isExplicitBackViewRequest(staged.text)
      ? confirmedPreviousView(runtime, message, availableViews, completedAction)
      : undefined;
    const priorAlias =
      prior?.view.id === matches[0].view.id ? prior.resolvedAlias : undefined;
    return {
      requiresTool: true,
      clearReply: true,
      addContexts: ["general"],
      clearCandidateActions: true,
      addCandidateActions: ["VIEWS"],
      clearParentActionHints: true,
      deterministicToolCall: {
        name: "VIEWS",
        params: {
          action: "show",
          view:
            requestedAlias ??
            priorAlias ??
            matches[0].resolvedAlias ??
            matches[0].view.id,
        },
      },
    };
  },
};
