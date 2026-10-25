/**
 * Keeps the authorized action catalog discoverable while a turn loads only the
 * schemas it needs. Discovery has no domain effects: it adds complete authorized
 * operations or explicitly requested families to this turn's native tools.
 * The normal executor still checks their permissions before dispatch.
 */

import type {
  Action,
  AgentContext,
  ContextObject,
  IAgentRuntime,
  Memory,
  RoleGateRole,
  ToolDefinition,
} from "@elizaos/core";
import {
  actionGateRejection,
  DISCOVER_ACTIONS_NAME,
  DISCOVER_TOOLS_NAME,
  ElizaError,
  getUserMessageText,
  isDiscoveryActionName,
  isObjectRecord,
  normalizeActionJsonSchema,
  normalizeContextId,
} from "@elizaos/core";
import { buildActionCatalog } from "../../runtime/action-catalog";
import {
  actionDiscoveryContexts,
  DEFAULT_PLANNER_QUERY_TOOL_LIMIT,
  inferActionSearchContexts,
  retrieveContextualPlannerActions,
} from "./action-surface.js";
import {
  collectBudgetedStageOneCandidateActions,
  collectPlannerTools,
} from "./planned-tool.js";

/**
 * The families DISCOVER_ACTIONS may list and load: every registered action the
 * actor is authorized for under the action's OWN declared contexts — the same
 * rule the executor applies at dispatch (planned-tool.ts merges
 * `action.contexts` into the active set). The planner's exposed surface is
 * the Stage-1 context slice, and building the catalog from that slice meant a
 * misrouted turn could never load the family it needed: "read the last 3
 * messages in the #general discord channel" was routed to `general`, the
 * planner asked for MESSAGE, and the catalog (42 families, no MESSAGE)
 * rejected it, so the reply came from the wrong room (live 2026-09-14,
 * tj-ab82a95eb85149). Private, disclosure and role gates run unchanged with
 * the real message and roles; only the context term is per-action.
 */
export function collectDiscoveryCatalogActions(args: {
  actions: readonly Action[];
  message: Memory;
  selectedContexts: readonly AgentContext[];
  userRoles: readonly RoleGateRole[];
}): Action[] {
  return args.actions.filter(
    (action) =>
      // Non-PLANNER modes belong to fixed lifecycle hooks, not model tools.
      (action.mode ?? "PLANNER") === "PLANNER" &&
      actionGateRejection(action, {
        message: args.message,
        userRoles: args.userRoles,
        activeContexts: actionDiscoveryContexts(action, args.selectedContexts),
      }) === undefined,
  );
}

/** Encode shared name prefixes reversibly; keep literal indexes when smaller. */
function renderDiscoveryNameIndex(
  parents: readonly { name: string; childNames: readonly string[] }[],
): string {
  const literal =
    "Index maps each exact family name to its exact child names (an empty list means no children):\n" +
    JSON.stringify(
      Object.fromEntries(
        parents.map((parent) => [parent.name, parent.childNames]),
      ),
    );
  const factored =
    'Index maps each exact family name to its children. Arrays contain exact names; an object {"_":[suffixes]} means each child is the family name + "_" + suffix. Empty arrays mean no children:\n' +
    JSON.stringify(
      Object.fromEntries(
        parents.map(({ name, childNames }) => {
          const prefix = `${name}_`;
          const children =
            childNames.length > 0 &&
            childNames.every((child) => child.startsWith(prefix))
              ? { _: childNames.map((child) => child.slice(prefix.length)) }
              : childNames;
          return [name, children];
        }),
      ),
    );
  return factored.length < literal.length ? factored : literal;
}

interface DiscoveryInvocationScope {
  runtime: IAgentRuntime;
  messageId: string;
  roomId: string;
  actorId: string;
}
const discoveryInvocationScopes = new WeakMap<
  NonNullable<Action["handler"]>,
  Readonly<DiscoveryInvocationScope>
>();
/** A name or renderer flag cannot impersonate the locally created pure tool. */
export function plannerDiscoveryInvocationScope(
  handler: unknown,
): Readonly<DiscoveryInvocationScope> | undefined {
  return typeof handler === "function"
    ? discoveryInvocationScopes.get(handler as NonNullable<Action["handler"]>)
    : undefined;
}

export function createPlannerToolDiscoveryAction(
  authorizedActions: readonly Action[],
  onDiscover: (actions: Action[], requestedNames: readonly string[]) => void,
  /** Resolve named operations; [] requests fresh admission of the full catalog. */
  resolveAdditionalActions?: (names: string[]) => Promise<Action[]>,
  /** Keep legacy callers inline; reference mode uses the existing catalog read. */
  options?: {
    deferNameIndex?: boolean;
    catalogIndex?: boolean;
    /** Current Stage-1 outcomes rank context-only loads, never explicit reads. */
    taskIntents?: readonly string[];
    admissionScope?: DiscoveryInvocationScope;
  },
): Action {
  const catalogIndex = options?.catalogIndex === true;
  if (authorizedActions.some((action) => isDiscoveryActionName(action.name))) {
    throw new ElizaError(
      "Planner discovery name conflicts with a registered action",
      {
        code: "PLANNER_DISCOVERY_NAME_CONFLICT",
      },
    );
  }
  const catalogFor = (actions: readonly Action[]) => {
    const names = new Set(actions.map((action) => action.name));
    return buildActionCatalog(
      actions.map((action) => ({
        ...action,
        subActions: action.subActions?.filter((child) =>
          names.has(typeof child === "string" ? child : child.name),
        ),
      })),
      { includeSearchMetadata: false },
    );
  };
  const catalog = catalogFor(authorizedActions);
  const discoveryDescription =
    "Find authorized operations that are not already exposed, or inspect definitions when explicitly requested. Exposed tools already have complete schemas: call a fitting one directly instead of discovering or loading it again. " +
    "Find authorized operations by query and/or contexts, or load exact names (parents load their families). Exact names plus query must match both; names cannot be combined with contexts. " +
    "mode=load enables complete schemas in the next tool surface; use loaded tools to perform work. " +
    "Empty load selectors search the current task. mode=describe reads complete descriptions and schemas for exact names or matching queries without enabling tools. With no selectors, mode=describe,names=[] returns only the complete authorized name index. " +
    (catalogIndex
      ? "Without task context, names=[] returns a routing index. "
      : "") +
    "Discovery refreshes permissions and never executes domain work. A search miss does not prove a capability is unavailable.";
  const inlineDescription = `${discoveryDescription}\n${renderDiscoveryNameIndex(catalog.parents)}`;
  const referenceDescription = `${discoveryDescription} No name index is preloaded here.`;
  const discoveryAction: Action = {
    name: DISCOVER_ACTIONS_NAME,
    similes: [DISCOVER_TOOLS_NAME],
    description: options?.deferNameIndex
      ? referenceDescription
      : inlineDescription,
    parameters: [
      {
        name: "mode",
        description:
          "load (default) enables matching tools; describe reads selected definitions, or the compact name index when no selectors are supplied.",
        required: false,
        schema: { type: "string", enum: ["load", "describe"] },
      },
      {
        name: "names",
        description: catalogIndex
          ? "Exact authorized names. If query is also supplied, every name must match that query and fresh authorization; never combine names with contexts. [] searches the current task (routing index only when task context is absent). Use mode=describe,names=[] for the full name index; choose exact names for full definitions."
          : "Exact authorized parent or child names. If query is also supplied, every name must match that query and fresh authorization; never combine names with contexts. Empty load selectors search the current task; mode=describe,names=[] reads the compact complete name index without loading tools.",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "query",
        description: `Find operations by intent without knowing names. Registered domain names in the query scope the search when contexts is omitted. With exact names, every name must match this query and fresh authorization; this never expands the named set. Without names, selects up to ${DEFAULT_PLANNER_QUERY_TOOL_LIMIT} ranked complete operations; remaining matches stay available through exact names or a narrower search.`,
        required: false,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "contexts",
        description: `Optional exact domain IDs to scope search. Without a query, load ranks the current task; describe lists domain members. Selects up to ${DEFAULT_PLANNER_QUERY_TOOL_LIMIT} operations. Cannot combine with names.`,
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
    ],
    validate: async () => true,
    handler: async (runtime, message, _state, callOptions) => {
      const mode = isObjectRecord(callOptions?.parameters)
        ? callOptions.parameters.mode
        : undefined;
      let names = isObjectRecord(callOptions?.parameters)
        ? callOptions.parameters.names
        : undefined;
      let query = isObjectRecord(callOptions?.parameters)
        ? callOptions.parameters.query
        : undefined;
      const contexts = isObjectRecord(callOptions?.parameters)
        ? callOptions.parameters.contexts
        : undefined;
      const emptyLoad =
        mode !== "describe" &&
        query === undefined &&
        contexts === undefined &&
        (names === undefined || (Array.isArray(names) && names.length === 0));
      if (emptyLoad && (mode === undefined || mode === "load")) {
        const currentTask =
          getUserMessageText(message) || options?.taskIntents?.join("\n") || "";
        if (currentTask.trim()) {
          query = currentTask;
          names = undefined;
        } else if (!(catalogIndex && Array.isArray(names))) {
          return {
            success: false,
            error:
              "Supply an intent query or exact names to load tools; use mode=describe,names=[] to read the complete authorized name index. No tools were loaded.",
            data: { readOnlyOperation: true, coachingFailure: true },
          };
        }
      }
      // An empty exact-name selector adds no restriction to an explicit search.
      if (
        Array.isArray(names) &&
        names.length === 0 &&
        (query !== undefined || contexts !== undefined)
      )
        names = undefined;
      // A model may accompany an exact name with its search intent. Treat this
      // as an intersection, never as a wider search or an ignored constraint.
      if (
        Array.isArray(names) &&
        names.length > 0 &&
        query !== undefined &&
        contexts === undefined &&
        (mode === undefined || mode === "load" || mode === "describe") &&
        names.every(
          (name): name is string => typeof name === "string" && name.length > 0,
        ) &&
        typeof query === "string" &&
        query.trim()
      ) {
        const freshActions = resolveAdditionalActions
          ? await resolveAdditionalActions(names)
          : [...authorizedActions];
        const exact = freshActions.filter((action) =>
          names.includes(action.name),
        );
        const matches = retrieveContextualPlannerActions({
          actions: exact,
          query,
        }).actions;
        if (
          names.every((name) => matches.some((action) => action.name === name))
        ) {
          if (mode !== "describe") onDiscover(matches, names);
          return {
            success: true,
            transcriptVisibility: "internal",
            modelReplyRequired: true,
            text: "Exact authorized names matched the supplied query. Complete schemas are available; continue with the requested operation. No domain work was performed.",
            data: {
              readOnlyOperation: true,
              ...(mode === "describe"
                ? {
                    catalog: matches.map((action) => ({
                      name: action.name,
                      description: action.description,
                      parameters: normalizeActionJsonSchema(action),
                    })),
                  }
                : {
                    loadedOperationCount: matches.length,
                    loadedTools: matches.map((action) => action.name),
                  }),
            },
          };
        }
        const available = resolveAdditionalActions
          ? await resolveAdditionalActions([])
          : [...authorizedActions];
        const suggestions = retrieveContextualPlannerActions({
          actions: available,
          query,
        }).actions.map((action) => action.name);
        return {
          success: false,
          error:
            "The exact names did not match both current authorization and the supplied query. No tools were loaded. Use the available matching names or a query alone.",
          data: {
            readOnlyOperation: true,
            coachingFailure: true,
            availableMatchingNames: suggestions,
          },
        };
      }
      const searching = query !== undefined || contexts !== undefined;
      if (searching) {
        if (
          names !== undefined ||
          (mode !== undefined && mode !== "load" && mode !== "describe") ||
          (query !== undefined &&
            (typeof query !== "string" || !query.trim())) ||
          (contexts !== undefined &&
            (!Array.isArray(contexts) ||
              contexts.length === 0 ||
              !contexts.every(
                (context): context is string =>
                  typeof context === "string" && context.trim().length > 0,
              )))
        ) {
          return {
            success: false,
            error:
              "Use query and/or contexts, or exact names, not both. No tools were loaded.",
            data: { readOnlyOperation: true, coachingFailure: true },
          };
        }
        const freshActions = resolveAdditionalActions
          ? await resolveAdditionalActions([])
          : [...authorizedActions];
        // A discovery query can name its domain without repeating `contexts`.
        // Match whole registered domain phrases, not arbitrary description words;
        // unknown domains keep global search and exact catalog loads stay available.
        const inferredContexts =
          contexts === undefined
            ? inferActionSearchContexts(
                freshActions,
                query ?? "",
                (context) => runtime.contexts?.get(context)?.aliases,
              )
            : [];
        const availableContexts = [
          ...new Set(
            freshActions
              .flatMap((action) => actionDiscoveryContexts(action))
              .map(normalizeContextId),
          ),
        ].sort();
        // Resolve only declared aliases of freshly authorized domains. An
        // unknown explicit context stays restrictive rather than widening to a
        // global search; canonical domain names take precedence over aliases.
        const explicitContexts = contexts?.flatMap((context) => {
          const normalized = normalizeContextId(context);
          if (availableContexts.includes(normalized)) return [normalized];
          const matching = availableContexts.filter((candidate) =>
            runtime.contexts
              ?.get(candidate)
              ?.aliases?.some(
                (alias) => normalizeContextId(alias) === normalized,
              ),
          );
          return matching.length > 0 ? matching : [normalized];
        });
        const searchContexts =
          explicitContexts ??
          (inferredContexts.length > 0 ? inferredContexts : undefined);
        const scopedActions =
          searchContexts === undefined
            ? freshActions
            : freshActions.filter((action) =>
                actionDiscoveryContexts(action).some((context) =>
                  searchContexts
                    .map(normalizeContextId)
                    .includes(normalizeContextId(context)),
                ),
              );
        // Context-only loading serves this turn's work. Explicit describe/catalog
        // reads retain membership semantics; an explicit query remains authoritative.
        const taskQuery =
          query === undefined && mode !== "describe"
            ? getUserMessageText(message) ||
              options?.taskIntents?.join("\n") ||
              ""
            : "";
        const selection = retrieveContextualPlannerActions({
          actions: scopedActions,
          query: query ?? taskQuery,
          intents:
            (query === undefined || emptyLoad) && mode !== "describe"
              ? options?.taskIntents
              : undefined,
          contexts: searchContexts,
        });
        const selected = selection.actions;
        if (mode !== "describe" && selected.length > 0)
          onDiscover(
            selected,
            selected.map((action) => action.name),
          );
        return {
          success: true,
          transcriptVisibility: "internal",
          modelReplyRequired: true,
          text:
            selected.length === 0
              ? "No matching operations. Rephrase the query or select from availableContexts to retry a scoped search. Explicit mode=describe,names=[] remains available for the complete authorized name index. No tools were loaded or executed."
              : mode === "describe"
                ? "Complete descriptions and schemas for the selected matching operations. Deferred matches remain discoverable. No tools were enabled or executed."
                : "Selected matching tools enabled. Deferred matches remain available through exact names, a narrower search or mode=describe,names=[] for the complete name index; no domain work was executed.",
          data: {
            readOnlyOperation: true,
            ...(inferredContexts.length > 0 ? { inferredContexts } : {}),
            ...(selected.length === 0 ? { availableContexts } : {}),
            matchCount: selection.matchCount,
            selectedCount: selection.selectedCount,
            deferredCount: selection.deferredCount,
            completeMatches: selection.deferredCount === 0,
            ...(mode === "describe"
              ? {
                  catalog: selected.map((action) => ({
                    name: action.name,
                    description: action.description,
                    parameters: normalizeActionJsonSchema(action),
                  })),
                }
              : {
                  loadedOperationCount: selected.length,
                  loadedTools: selected.map((action) => action.name),
                }),
          },
        };
      }
      if (
        (mode !== undefined && mode !== "load" && mode !== "describe") ||
        !Array.isArray(names) ||
        !names.every(
          (name): name is string => typeof name === "string" && name.length > 0,
        )
      ) {
        // A miss loads nothing and changes nothing: it steers the model
        // (coachingFailure) and never owns the turn's final message, which
        // otherwise shipped "the available runtime step failed" over a
        // later successful answer (live 2026-09-14, tj-8ce2f7a7e5384b).
        return {
          success: false,
          error:
            "Select exact names from the authorized discovery catalog. No tools were loaded.",
          data: { readOnlyOperation: true, coachingFailure: true },
        };
      }
      if (names.length === 0 || mode === "describe") {
        // A mistaken Stage-1 domain must not make another authorized
        // domain undiscoverable. This explicit read refreshes admission;
        // it neither loads schemas nor changes execution permission.
        const freshActions = resolveAdditionalActions
          ? await resolveAdditionalActions(names)
          : [...authorizedActions];
        const admittedNames = new Set(
          freshActions.map((action) => action.name),
        );
        if (!names.every((name) => admittedNames.has(name))) {
          return {
            success: false,
            error:
              "Requested descriptions were not admitted by current capability and permission checks. No tools were loaded. Use mode=describe,names=[] to inspect the current authorized catalog.",
            data: { readOnlyOperation: true, coachingFailure: true },
          };
        }
        const describedActions =
          names.length === 0
            ? freshActions
            : collectBudgetedStageOneCandidateActions({
                actions: freshActions,
                candidateActions: names,
                contexts: [],
                deferUnselectedContexts: true,
              });
        const completeCatalog = catalogFor(describedActions);
        const parameterSchemas = new Map(
          names.length === 0
            ? []
            : describedActions.map((action) => [
                action.name,
                normalizeActionJsonSchema(action),
              ]),
        );
        if (names.length === 0) {
          return {
            success: true,
            transcriptVisibility: "internal",
            modelReplyRequired: true,
            text: "Complete authorized name index only. Routing hints are summaries, not full definitions. Use exact names or an intent query for complete descriptions and schemas. Every listed operation remains discoverable; no tools were loaded or executed.",
            data: {
              readOnlyOperation: true,
              catalogDetail: "index",
              completeNames: true,
              catalog: completeCatalog.parents.map((parent) => ({
                name: parent.name,
                routingHint: (
                  parent.routingHint ||
                  parent.source.descriptionCompressed ||
                  parent.source.description ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 160),
                children: parent.childNames,
              })),
            },
          };
        }
        return {
          success: true,
          transcriptVisibility: "internal",
          modelReplyRequired: true,
          text:
            names.length === 0
              ? "Complete authorized name index. Select exact names for definitions; no domain work was performed."
              : "Complete descriptions and parameter schemas for the requested authorized tools. Other families remain discoverable with mode=describe,names=[]. No tools were enabled or domain work performed.",
          data: {
            readOnlyOperation: true,
            catalog: completeCatalog.parents.map((parent) => ({
              name: parent.name,
              description: parent.source.description,
              ...(names.length > 0
                ? { parameters: parameterSchemas.get(parent.name) }
                : {}),
              children: parent.childNames,
              childDefinitions: parent.children.map((child) => ({
                name: child.name,
                description: child.source.description,
                ...(names.length > 0
                  ? { parameters: parameterSchemas.get(child.name) }
                  : {}),
              })),
            })),
          },
        };
      }
      // Stage 1 can omit a domain even when the planner explicitly requests
      // its family. Reuse canonical candidate admission with that exact name;
      // never turn routing context into a permanent capability denial.
      const admitted = new Map(
        (resolveAdditionalActions
          ? await resolveAdditionalActions(names)
          : authorizedActions
        ).map((action) => [action.name, action]),
      );
      if (!names.every((name) => admitted.has(name))) {
        return {
          success: false,
          error:
            "Requested tool family was not admitted by the current capability and permission checks. No tools were loaded. Search by query/context, or use mode=describe,names=[] for the complete catalog. Do not substitute an unrelated family for the requested operation.",
          data: {
            readOnlyOperation: true,
            coachingFailure: true,
          },
        };
      }
      const selected = collectBudgetedStageOneCandidateActions({
        actions: [...admitted.values()],
        candidateActions: names,
        contexts: [],
        deferUnselectedContexts: true,
      });
      onDiscover(selected, names);
      return {
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        text: "Named tools enabled for execution with complete schemas in the current tool surface. No domain work or data mutation ran. Use those tools to continue the requested work.",
        data: {
          readOnlyOperation: true,
          // Operations may share a canonical parent on the native tool wire.
          loadedOperationCount: selected.length,
          loadedTools: selected.map((action) => action.name),
        },
      };
    },
    examples: [],
  };
  if (options?.admissionScope && discoveryAction.handler)
    discoveryInvocationScopes.set(
      discoveryAction.handler,
      Object.freeze({ ...options.admissionScope }),
    );
  return discoveryAction;
}

/** Keep explicitly requested operations direct. Represent generated siblings
 * through their complete parent contract, as in initial planner assembly.
 * Callers without requested names retain the legacy expanded surface. Existing
 * definitions and backing execution actions remain unchanged. */
export function appendDiscoveredPlannerTools(
  context: ContextObject,
  current: ToolDefinition[],
  discovered: readonly Action[],
  requestedNames?: readonly string[],
): void {
  const names = new Set(current.map((tool) => tool.name));
  // Explicit child selections retain their native constraints. Named families
  // still consolidate unselected siblings through the complete umbrella;
  // legacy callers without names retain the flat expansion.
  for (const tool of collectPlannerTools(context, discovered, {
    canonicalFamilies: requestedNames !== undefined,
    directActionNames: new Set(requestedNames),
  })) {
    if (!names.has(tool.name)) {
      current.push(tool);
      names.add(tool.name);
    }
  }
}
