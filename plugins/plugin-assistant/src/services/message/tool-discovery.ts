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
  Memory,
  RoleGateRole,
  ToolDefinition,
} from "@elizaos/core";
import {
  actionGateRejection,
  DISCOVER_ACTIONS_NAME,
  DISCOVER_TOOLS_NAME,
  ElizaError,
  isDiscoveryActionName,
  isObjectRecord,
  normalizeActionJsonSchema,
  normalizeContextId,
} from "@elizaos/core";
import { buildActionCatalog } from "../../runtime/action-catalog";
import {
  actionDiscoveryContexts,
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

export function createPlannerToolDiscoveryAction(
  authorizedActions: readonly Action[],
  onDiscover: (actions: Action[], requestedNames: readonly string[]) => void,
  /** Resolve named operations; [] requests fresh admission of the full catalog. */
  resolveAdditionalActions?: (names: string[]) => Promise<Action[]>,
  /** Keep legacy callers inline; reference mode uses the existing catalog read. */
  options?: { deferNameIndex?: boolean; catalogIndex?: boolean },
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
    "Find authorized operations by query and/or contexts, or load exact names (parents load their families). " +
    "To perform work use mode=load: complete schemas appear in the next tool surface. " +
    "mode=describe answers capability or parameter questions without enabling tools. " +
    "names=[] reads the complete authorized catalog. Search and loads refresh permissions; no domain work executes. " +
    "Use loaded tools to perform work. A search miss does not prove a capability is unavailable.";
  const inlineDescription = `${discoveryDescription}\n${renderDiscoveryNameIndex(catalog.parents)}`;
  const referenceDescription = `${discoveryDescription} No name index is preloaded here.`;
  return {
    name: DISCOVER_ACTIONS_NAME,
    similes: [DISCOVER_TOOLS_NAME],
    description: options?.deferNameIndex
      ? referenceDescription +
        (catalogIndex
          ? " Empty names returns a routing index; use mode=describe for complete descriptions."
          : "")
      : inlineDescription +
        (catalogIndex
          ? " Empty names returns a routing index; use mode=describe for complete descriptions."
          : ""),
    parameters: [
      {
        name: "mode",
        description:
          "load (default) enables named tools; describe reads complete descriptions and, for named tools, parameter schemas. Neither executes domain work.",
        required: false,
        schema: { type: "string", enum: ["load", "describe"] },
      },
      {
        name: "names",
        description: catalogIndex
          ? "Exact authorized names; [] reads the routing index, or full descriptions with mode=describe."
          : "Exact authorized parent or child names to load or describe; [] reads all catalog descriptions without loading tools.",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "query",
        description:
          "Find operations by intent without knowing names. Cannot combine with names; all matching operations are returned without a result cap.",
        required: false,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "contexts",
        description:
          "Optional exact domain IDs to scope query search, or list domain operations without a query. Cannot combine with names.",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
    ],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options) => {
      const mode = isObjectRecord(options?.parameters)
        ? options.parameters.mode
        : undefined;
      const names = isObjectRecord(options?.parameters)
        ? options.parameters.names
        : undefined;
      const query = isObjectRecord(options?.parameters)
        ? options.parameters.query
        : undefined;
      const contexts = isObjectRecord(options?.parameters)
        ? options.parameters.contexts
        : undefined;
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
        const scopedActions =
          contexts === undefined
            ? freshActions
            : freshActions.filter((action) =>
                actionDiscoveryContexts(action).some((context) =>
                  contexts
                    .map(normalizeContextId)
                    .includes(normalizeContextId(context)),
                ),
              );
        const selected =
          query === undefined
            ? scopedActions
            : retrieveContextualPlannerActions({
                actions: scopedActions,
                query,
                contexts,
              });
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
              ? "No matching operations. Rephrase the query, change contexts, or use names=[] to read the complete authorized catalog. No tools were loaded or executed."
              : mode === "describe"
                ? "Complete matching operation descriptions and schemas. No tools were enabled or executed."
                : "Matching tools enabled. Other operations remain discoverable; no domain work was executed.",
          data: {
            readOnlyOperation: true,
            matchCount: selected.length,
            completeMatches: true,
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
              "Requested descriptions were not admitted by current capability and permission checks. No tools were loaded. Use names=[] to inspect the current authorized catalog.",
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
        if (catalogIndex && names.length === 0 && mode !== "describe") {
          return {
            success: true,
            transcriptVisibility: "internal",
            modelReplyRequired: true,
            text: "Complete authorized name index. Summaries are for routing; use mode=describe with exact names for full descriptions, or mode=describe,names=[] for all descriptions. No tools were loaded or executed.",
            data: {
              readOnlyOperation: true,
              catalog: completeCatalog.parents.map((parent) => ({
                name: parent.name,
                routingHint:
                  parent.routingHint ||
                  parent.source.descriptionCompressed ||
                  parent.source.description,
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
              ? "Complete authorized catalog descriptions. Select exact names to load schemas; no domain work was performed."
              : "Complete descriptions and parameter schemas for the requested authorized tools. Other families remain discoverable with names=[]. No tools were enabled or domain work performed.",
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
            "Requested tool family was not admitted by the current capability and permission checks. No tools were loaded. Search by query/context, or use names=[] for the complete catalog. Do not substitute an unrelated family for the requested operation.",
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
