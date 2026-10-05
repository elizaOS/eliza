/** Builds the complete authorized planner action surface and caches rendered catalogs by runtime registration state. */

import type {
  Action,
  AgentContext,
  CodingActionProfile,
  IAgentRuntime,
  Memory,
  MessageHandlerResult,
  RoleGateRole,
  State,
  TrajectoryRecorder,
} from "@elizaos/core";
import {
  actionGateRejection,
  evaluateConnectorAccountPolicies,
  getDirectActionRoutingRules,
  getInferenceTimer,
  getUserMessageText,
  type LocalizedActionExampleResolver,
  normalizeContextId,
  readEnvBool,
  recordInferenceSpan,
  renewExpiredTrustedDeliveryAudience,
  withActiveRoutingContexts,
} from "@elizaos/core";
import {
  buildActionCatalog,
  normalizeActionName,
} from "../../runtime/action-catalog";
import {
  parentAliasesForCandidateAction,
  preferredOperationNames,
  retrieveActions,
  tokenizeActionSearchText,
} from "../../runtime/action-retrieval.ts";
import { tierActionResults } from "../../runtime/action-tiering.ts";
import {
  buildRuntimeActionLookup,
  resolveRuntimeAction,
} from "./action-identifiers.js";
import {
  getActionInferenceMessageText,
  getRecentConversationSearchText,
  isTaskCompleteRelayTurn,
} from "./dialogue-context.ts";
import { normalizeActionIdentifier } from "./direct-action-heuristics.ts";
import {
  hasUiViewPlannerScope,
  uiViewActionNames,
  uiViewActionPriority,
} from "./provider-state.ts";

/** Explicit resource/domain ownership outranks an incidental execution context.
 * A single-domain owner is more specific than a cross-domain coordinator.
 */
function plannerDomainOwnership(action: Action, domain: string): number {
  const domains = new Set(
    (action.tags ?? [])
      .filter((tag) => tag.startsWith("domain:"))
      .map((tag) => normalizeContextId(tag.slice(7))),
  );
  if (
    (action.tags ?? []).some(
      (tag) =>
        tag.startsWith("resource:") &&
        normalizeContextId(tag.slice(9)) === domain,
    )
  )
    return 3;
  if (domains.has(domain)) return 2 + 1 / domains.size;
  const contexts = actionDiscoveryContexts(action)
    .map(normalizeContextId)
    .filter((context) => context !== "general" && context !== "simple");
  return domains.size === 0 && contexts.length === 1 && contexts[0] === domain
    ? 3
    : 0;
}

export const DEFAULT_PLANNER_QUERY_TOOL_LIMIT = 10;

/** Domain phrases are natural words, not subwords of identifiers or paths. */
function containsDomainPhrase(query: string, name: string): boolean {
  const variants = new Set([name, name.replace(/_/g, " ")]);
  return [...variants].some((variant) => {
    const phrase = variant
      .trim()
      .split(/\s+/u)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    if (!phrase) return false;
    // A final period/colon is sentence punctuation; punctuation joining a
    // following identifier is part of a filename, path or compound key.
    return new RegExp(
      `(?<![\\p{L}\\p{N}_./:\\\\-])${phrase}(?![\\p{L}\\p{N}_/\\\\]|[.:-]+[\\p{L}\\p{N}_])`,
      "iu",
    ).test(query);
  });
}

/** Shared domain matching for explicit discovery and pending-intent bootstrap. */
export function inferActionSearchContexts(
  actions: readonly Action[],
  query: string,
  aliases?: (context: string) => readonly string[] | undefined,
): string[] {
  return [
    ...new Set(actions.flatMap((action) => actionDiscoveryContexts(action))),
  ].filter((context) => {
    const normalized = normalizeContextId(context);
    return (
      normalized !== "general" &&
      normalized !== "simple" &&
      [normalized, ...(aliases?.(normalized) ?? [])].some((name) =>
        containsDomainPhrase(query, name),
      )
    );
  });
}

/** Generic operation verbs name no specific capability on their own. */
const GENERIC_OPERATION_WORDS = new Set([
  "list",
  "search",
  "find",
  "lookup",
  "create",
  "add",
  "write",
  "save",
  "update",
  "edit",
  "change",
  "modify",
  "replace",
  "patch",
  "delete",
  "remove",
  "erase",
  "get",
  "read",
  "retrieve",
  "next",
  "upcoming",
  "open",
  "navigate",
  "show",
  "close",
  "send",
  "set",
  "run",
]);

function pendingActionContexts(
  actions: readonly Action[],
  intents: readonly string[] | undefined,
  aliases?: (context: string) => readonly string[] | undefined,
  selectedActions?: readonly Action[],
): string[] {
  // These are exposure hints only. Ambiguous/negated clauses and navigation
  // destinations remain discoverable instead of loading their record tools.
  // A clause whose verb already names a Stage-1 selected action ("echo this
  // message back to me: hello world" -> ECHO_TEST) is claimed by that action.
  // An incidental domain word in it (MESSAGE's `world` context) is not a
  // second domain intent unless the clause also names one of that domain's
  // operations; otherwise the family stays behind DISCOVER_ACTIONS (#31017).
  const claimWords = new Set(
    (selectedActions ?? []).flatMap((action) =>
      tokenizeActionSearchText(action.name).filter(
        (word) => word.length > 2 && !GENERIC_OPERATION_WORDS.has(word),
      ),
    ),
  );
  const domains = new Set<string>();
  for (const intent of (intents ?? []).map(positiveIntentText)) {
    const words = tokenizeActionSearchText(intent);
    const claimed = words.some((word) => claimWords.has(word));
    if (
      words.length === 0 ||
      ["open", "navigate", "switch", "go", "show", "close", "return"].includes(
        words[0],
      )
    )
      continue;
    // Readback identifiers are data, not programming work. This affects only
    // inferred extra domains; explicit contexts, action names and discovery
    // queries retain their ordinary meaning and complete source text.
    const programmingText = intent.replace(
      /\b(?:verification|reference)\s+codes?\b/giu,
      " ",
    );
    for (const context of inferActionSearchContexts(actions, intent, aliases)) {
      const domain = normalizeContextId(context);
      if (domains.has(domain)) continue;
      if (
        domain === "code" &&
        !["code", ...(aliases?.("code") ?? [])].some((name) =>
          containsDomainPhrase(programmingText, name),
        )
      )
        continue;
      if (!claimed) {
        domains.add(domain);
        continue;
      }
      const operations = actions
        .filter((action) =>
          actionDiscoveryContexts(action).some(
            (candidate) => normalizeContextId(candidate) === domain,
          ),
        )
        .map((action) => action.name);
      if (preferredOperationNames(intent, operations).size > 0)
        domains.add(domain);
    }
  }
  return [...domains];
}

const OPERATION_CONNECTORS = new Set([
  "with",
  "to",
  "from",
  "of",
  "in",
  "by",
  "for",
  "and",
]);

function operationWords(
  name: string,
  parentWords: ReadonlySet<string>,
): string[] {
  return tokenizeActionSearchText(name).filter(
    (word) => !parentWords.has(word) && !OPERATION_CONNECTORS.has(word),
  );
}

function positiveIntentText(intent: string): string {
  const unquoted = intent.replace(
    /"[^"]*"|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])|“[^”]*”|‘[^’]*’|`[^`]*`/gu,
    " ",
  );
  return /\b(?:not|never|without|don['’]t|cannot|can['’]t)\b/iu.test(unquoted)
    ? ""
    : unquoted.trim();
}

/**
 * Retrieve complete operation definitions from an already authorized registry.
 * Search operates on individual operations rather than expanding every matched
 * parent into its siblings. Bound the selected surface, never the catalog or
 * ranker; exact hints remain required and deferred operations stay discoverable.
 */
export function retrieveContextualPlannerActions(args: {
  actions: readonly Action[];
  query: string;
  /** Model-selected outcomes rank operations; the full request still ranks domains. */
  intents?: readonly string[];
  contexts?: readonly string[];
  /** Preserve exact hints while filling only domains they do not own. */
  selectedActions?: readonly Action[];
  contextAliases?: (context: string) => readonly string[] | undefined;
  /** Initial routing may defer ambiguous domains; explicit discovery stays global. */
  deferUnscopedBootstrap?: boolean;
}): {
  actions: Action[];
  matchCount: number;
  selectedCount: number;
  deferredCount: number;
} {
  const retrieval = args.query.trim()
    ? retrieveActions({
        catalog: buildActionCatalog(
          args.actions.map((action) => ({ ...action, subActions: undefined })),
        ),
        messageText: args.query,
        intents: args.intents,
        selectedContexts: args.contexts,
      })
    : undefined;
  const actionsByName = new Map(
    args.actions.map((action) => [action.name, action]),
  );
  const matches = retrieval
    ? retrieval.results.flatMap((result) => {
        const action = actionsByName.get(result.name);
        return action && result.score > 0 ? [action] : [];
      })
    : [...args.actions];
  // Routing narrows the bootstrap, not registry availability. A mistaken or
  // unknown domain with no matches falls back to the authorized global search;
  // DISCOVER_ACTIONS also permits explicit searches outside the initial domains.
  const declaredDomains = new Set(
    (args.contexts ?? [])
      .map(normalizeContextId)
      .filter((context) => context !== "general" && context !== "simple"),
  );
  const domains = new Set([
    ...declaredDomains,
    ...pendingActionContexts(
      args.actions,
      args.intents,
      args.contextAliases,
      args.selectedActions,
    ),
  ]);
  if (args.deferUnscopedBootstrap && domains.size === 0) {
    const required = [
      ...new Map(
        (args.selectedActions ?? []).map((action) => [action.name, action]),
      ).values(),
    ];
    const requiredNames = new Set(required.map((action) => action.name));
    return {
      actions: required,
      matchCount: matches.length,
      selectedCount: required.length,
      deferredCount: matches.filter((action) => !requiredNames.has(action.name))
        .length,
    };
  }
  const selectMatches = (ranked: readonly Action[]) => {
    const required = [
      ...new Map(
        (args.selectedActions ?? []).map((action) => [action.name, action]),
      ).values(),
    ];
    const requiredNames = new Set(required.map((action) => action.name));
    const candidates = ranked.filter(
      (action) => !requiredNames.has(action.name),
    );
    const available = Math.max(
      0,
      DEFAULT_PLANNER_QUERY_TOOL_LIMIT - required.length,
    );
    const chosen = new Set<string>();
    // Keep a representative for each selected uncovered domain before filling
    // the remaining slots by rank. Exact hints may exceed this automatic budget.
    for (const domain of domains) {
      if (chosen.size >= available) break;
      const representative = candidates.find((action) =>
        actionDiscoveryContexts(action).some(
          (context) => normalizeContextId(context) === domain,
        ),
      );
      if (representative) chosen.add(representative.name);
    }
    for (const action of candidates) {
      if (chosen.size >= available) break;
      chosen.add(action.name);
    }
    const actions = [
      ...required,
      ...candidates.filter((action) => chosen.has(action.name)),
    ];
    const matchCount = required.length + candidates.length;
    return {
      actions,
      matchCount,
      selectedCount: actions.length,
      deferredCount: matchCount - actions.length,
    };
  };
  if (args.selectedActions) {
    for (const domain of domains) {
      const strongest = Math.max(
        0,
        ...args.actions.map((action) => plannerDomainOwnership(action, domain)),
      );
      if (
        strongest > 0 &&
        args.selectedActions.some(
          (action) => plannerDomainOwnership(action, domain) === strongest,
        )
      )
        domains.delete(domain);
    }
    if (domains.size === 0) return selectMatches([]);
  }
  const domainMatches = matches.filter((action) =>
    actionDiscoveryContexts(action).some((context) =>
      domains.has(normalizeContextId(context)),
    ),
  );
  if (args.selectedActions && domainMatches.length === 0)
    return selectMatches([]);
  const domainRelevant = domainMatches.length > 0 ? domainMatches : matches;
  // Context-only discovery enumerates scoped membership, not query relevance.
  // Preserve every admitted parent/child and incidental-context member in its
  // match count; only automatic loading is bounded.
  if (!args.query.trim()) return selectMatches(domainRelevant);
  // Narrow each requested domain independently. A recognized notes operation
  // must not erase a calendar intent whose operation wording has no name match.
  const searchDomains = domains.size > 0 ? [...domains] : [undefined];
  const selected = new Set<Action>();
  const operationQuery =
    args.intents?.filter((intent) => intent.trim()).join("\n") || args.query;
  for (const domain of searchDomains) {
    const candidates =
      domain === undefined
        ? domainRelevant
        : domainRelevant.filter((action) =>
            actionDiscoveryContexts(action).some(
              (context) => normalizeContextId(context) === domain,
            ),
          );
    // Navigation changes the view, not its domain records. Retain an already
    // selected navigation operation only when every declared intent resolves
    // to it; a read/update intent must still load its resource owner.
    const selectedNames = new Set(
      args.selectedActions?.map((action) => action.name),
    );
    const navigationNames = new Set(
      [...selectedNames].filter(
        (name) => name === "VIEWS" || name === "VIEWS_SHOW",
      ),
    );
    // VIEWS is the authorized umbrella for the same show operation; using its
    // operation name here does not expose or authorize a separate child tool.
    if (navigationNames.has("VIEWS")) navigationNames.add("VIEWS_SHOW");
    const operationCandidates = [
      ...new Set([
        ...candidates.map((action) => action.name),
        ...navigationNames,
      ]),
    ];
    const intents = args.intents?.filter((intent) => intent.trim()) ?? [];
    const navigationOnly = (
      intents.length > 0 ? intents : [operationQuery]
    ).every((intent) => {
      const operations = preferredOperationNames(intent, operationCandidates);
      return (
        operations.size > 0 &&
        [...operations].every(
          (name) =>
            (name === "VIEWS" || name === "VIEWS_SHOW") &&
            navigationNames.has(name),
        )
      );
    });
    if (navigationOnly) {
      for (const action of candidates)
        if (
          selectedNames.has(action.name) &&
          (action.name === "VIEWS" || action.name === "VIEWS_SHOW")
        )
          selected.add(action);
      continue;
    }
    // Resolve domain ownership before operation verbs: a cross-domain helper
    // named *_READ must not eliminate the actual FILE/NOTES owner umbrella.
    const strongest =
      domain === undefined
        ? 0
        : Math.max(
            0,
            ...candidates.map((action) =>
              plannerDomainOwnership(action, domain),
            ),
          );
    const owners = candidates.filter(
      (action) =>
        domain === undefined ||
        strongest === 0 ||
        plannerDomainOwnership(action, domain) === strongest,
    );
    let operationNames = preferredOperationNames(
      domain !== undefined && !declaredDomains.has(domain)
        ? (args.intents ?? [])
            .map(positiveIntentText)
            .filter(Boolean)
            .join("\n")
        : operationQuery,
      owners.map((action) => action.name),
    );
    // A generic verb alone matches unrelated families (CREATE loads alarms,
    // reminders, calendar, etc.). For a simple explicit resource request,
    // prefer matching operation names; unknown or compound wording retains
    // the existing discovery fallback. This only narrows automatic exposure.
    const resourceQuery = positiveIntentText(operationQuery);
    // Umbrellas may express operations through aliases rather than their
    // canonical name. Keep an explicitly requested resource + operation alias
    // before generic *_CREATE siblings narrow the surface. A verb-only alias
    // or an incidental description match must not admit an unrelated family.
    if (resourceQuery) {
      for (const action of owners) {
        if (
          (action.similes ?? []).some((alias) => {
            const words = tokenizeActionSearchText(alias);
            return (
              preferredOperationNames(resourceQuery, [alias]).size > 0 &&
              words.some(
                (word) =>
                  !GENERIC_OPERATION_WORDS.has(word) &&
                  !OPERATION_CONNECTORS.has(word),
              ) &&
              words.every((word) => containsDomainPhrase(resourceQuery, word))
            );
          })
        )
          operationNames.add(action.name);
      }
    }
    if (
      operationNames.size > 0 &&
      resourceQuery &&
      (args.intents?.length ?? 0) <= 1 &&
      tokenizeActionSearchText(resourceQuery).filter((word) =>
        GENERIC_OPERATION_WORDS.has(word),
      ).length === 1 &&
      !/\b(?:and|or|also|plus|then|if|when|unless|before|after|while)\b|[;,]/iu.test(
        resourceQuery,
      )
    ) {
      const resourceNames = owners
        .filter(
          (action) =>
            operationNames.has(action.name) &&
            [
              action.name,
              ...(action.similes ?? []),
              ...(action.similes ?? []).flatMap((alias) => {
                const parent = actionsByName.get(normalizeActionName(alias));
                return parent?.subActions?.length ? (parent.similes ?? []) : [];
              }),
            ].some((alias) => {
              const words = tokenizeActionSearchText(alias).filter(
                (word) =>
                  word !== "owner" &&
                  !/^\d+$/u.test(word) &&
                  !GENERIC_OPERATION_WORDS.has(word) &&
                  !OPERATION_CONNECTORS.has(word),
              );
              return (
                words.length > 0 &&
                words.every((word) => containsDomainPhrase(resourceQuery, word))
              );
            }),
        )
        .map((action) => action.name);
      if (resourceNames.length > 0) operationNames = new Set(resourceNames);
    }
    if (operationNames.size > 0) {
      const wanted = new Set(operationNames);
      const clauses = args.intents?.length ? args.intents : [operationQuery];
      for (const parent of owners) {
        const childNames = new Set(
          parent.subActions?.map((child) =>
            typeof child === "string" ? child : child.name,
          ),
        );
        const children = owners.filter(
          (action) => childNames.has(action.name) && wanted.has(action.name),
        );
        if (children.length < 2) continue;
        const parentWords = new Set(tokenizeActionSearchText(parent.name));
        const wordsFor = (action: Action) =>
          operationWords(action.name, parentWords);
        const retained = new Set<string>();
        for (const clause of clauses) {
          const unquoted = clause.replace(
            /"[^"]*"|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])|“[^”]*”|‘[^’]*’|`[^`]*`/gu,
            " ",
          );
          const clauseWords = new Set(tokenizeActionSearchText(unquoted));
          const mentions = (word: string) =>
            clauseWords.has(word) ||
            clauseWords.has(`${word}s`) ||
            clauseWords.has(`${word}ed`) ||
            (word.endsWith("e") && clauseWords.has(`${word}d`));
          const preferred = preferredOperationNames(
            unquoted,
            children.map((action) => action.name),
          );
          const candidates = children.filter((action) =>
            preferred.has(action.name),
          );
          // Unstructured compound wording is ambiguous. Keep its alternatives;
          // model-selected intents provide independent outcome boundaries.
          if (/\band\b|[;,]/iu.test(unquoted)) {
            for (const action of candidates) retained.add(action.name);
            continue;
          }
          for (const action of candidates) {
            const words = wordsFor(action);
            const superseded = candidates.some((other) => {
              if (other === action) return false;
              const otherWords = wordsFor(other);
              const extra = words.filter((word) => !otherWords.includes(word));
              const otherExtra = otherWords.filter(
                (word) => !words.includes(word),
              );
              // Prefer the more specific operation only when its qualifier was
              // requested; otherwise use the complete base operation. Evaluate
              // each requested outcome independently before taking the union.
              if (extra.length > 0 && otherExtra.length === 0)
                return !extra.every(mentions);
              if (extra.length === 0 && otherExtra.length > 0)
                return otherExtra.every(mentions);
              if (
                words.some((word) => otherWords.includes(word)) &&
                otherExtra.length > 0 &&
                otherExtra.every(mentions) &&
                extra.every((word) => !mentions(word))
              )
                return true;
              // Search supports list as a fallback, not every list sibling
              // alongside an available search operation in the same family.
              return (
                words.includes("list") &&
                otherWords.includes("search") &&
                !clauseWords.has("list") &&
                ["search", "find", "lookup"].some((word) =>
                  clauseWords.has(word),
                )
              );
            });
            if (!superseded) retained.add(action.name);
          }
        }
        if (retained.size > 0)
          for (const child of children)
            if (!retained.has(child.name)) wanted.delete(child.name);
      }
      for (const action of owners)
        if (wanted.has(action.name)) selected.add(action);
      continue;
    }
    // A family word ("message") is not a request for every sibling operation.
    // Keep its authorized umbrella when the operation is unresolved. Explicit
    // child words ("inbox", "triage") still select their complete definitions,
    // including operations outside the generic verb vocabulary above.
    const queryWords = new Set(tokenizeActionSearchText(operationQuery));
    const deferredFamilyNames = new Set<string>();
    for (const parent of owners) {
      const childNames = new Set(
        parent.subActions?.map((child) =>
          typeof child === "string" ? child : child.name,
        ),
      );
      const children = owners.filter((action) => childNames.has(action.name));
      if (children.length === 0) continue;
      const parentWords = new Set(tokenizeActionSearchText(parent.name));
      const explicitChildren = children.filter((action) =>
        operationWords(action.name, parentWords).some((word) =>
          queryWords.has(word),
        ),
      );
      if (explicitChildren.length === 0 && typeof parent.handler !== "function")
        continue;
      for (const child of children) deferredFamilyNames.add(child.name);
      deferredFamilyNames.add(parent.name);
      for (const action of explicitChildren.length > 0
        ? explicitChildren
        : [parent])
        selected.add(action);
    }
    for (const action of owners)
      if (!deferredFamilyNames.has(action.name)) selected.add(action);
  }
  // A selected context with no registry matches must still permit global lookup.
  const relevant =
    selected.size > 0
      ? domainRelevant.filter((action) => selected.has(action))
      : domainRelevant;
  const names = new Set(relevant.map((action) => action.name));
  const retrieved = relevant.filter(
    (action) =>
      !action.subActions?.some((child) =>
        names.has(typeof child === "string" ? child : child.name),
      ),
  );
  return selectMatches(retrieved);
}

export type V5PlannerActionSurfaceSummary = {
  mode: "full" | "tiered" | "relay-delivery";
  candidateActionCount: number;
  /** Complete per-turn authorized catalog reachable through explicit discovery. */
  discoverableActionCount?: number;
  discoveryToolName?: string;
  catalogParentCount: number;
  exposedActionCount: number;
  tierAParents: string[];
  /** Every registered child exposed as a first-class planner tool per parent. */
  tierAChildrenByParent?: Record<string, string[]>;
  tierBParents: string[];
  omittedParentCount: number;
  omittedParentNamesPreview: string[];
  actionSurfaceHash?: string;
  warnings: number;
  /**
   * Size of the retrieval query, not its tokens: the summary is serialized
   * into the Stage-1 `message_handler` context event that the planner and
   * evaluator read, and the token array (the whole recent conversation when
   * retrieval widens the query) reached 262K characters on one live turn
   * (2026-09-13, planner prompt 89K tokens).
   */
  queryTokenCount: number;
  candidateActions: string[];
  parentActionHints: string[];
  codingActionProfile?: {
    kind: "pi";
    includeWorktree: boolean;
  };
  fallback?: string;
};

export type V5PlannerActionSurface = {
  exposedActionNames: Set<string>;
  summary: V5PlannerActionSurfaceSummary;
};

export async function collectV5PlannerCandidateActions(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State;
  selectedContexts?: readonly AgentContext[];
  candidateActions?: readonly string[];
  /** Positive requested outcomes may bootstrap discovery outside an incomplete context hint. */
  intents?: readonly string[];
  /** Discover routable actions before Stage 1 has selected their contexts. */
  discoverActions?: boolean;
  userRoles?: readonly RoleGateRole[];
  /** Out-param: normalized names and reasons for EXPLICIT stage-1 candidates
   * rejected by the owner-exclusive disclosure gate.
   * Lets the planner entry distinguish "capability exists but is gated on
   * this surface" from ordinary no-match, and answer honestly instead of
   * planning against an unrelated retrieval surface. */
  diagnostics?: {
    disclosureRejectedExplicitCandidates: string[];
    /** The disclosure reason per rejected explicit candidate, so the
     * privacy short-circuit can answer accurately: a non-owner
     * (`owner_mismatch`) needs a permission-truthful decline, while an owner
     * on a group surface (`participant_mismatch`) needs the "ask me in a DM"
     * routing hint. Same index order as
     * `disclosureRejectedExplicitCandidates`. */
    disclosureRejectedReasons: string[];
    /** Normalized names of EXPLICIT stage-1 candidates rejected by a
     * NON-disclosure gate: role/context/private-action (#20679), plus
     * connector-account-policy denials, unavailable explicit capabilities,
     * `validate() === false`, and failed policy/validation checks (#20869). A
     * privacy denial only proves a disclosure boundary; when the same turn also
     * has a non-disclosure rejection the request is compound, so the privacy
     * short-circuit must stand down and let the planner/recovery path answer the
     * non-disclosure limitation honestly. */
    nonDisclosureRejectedExplicitCandidates: string[];
  };
}): Promise<Action[]> {
  // Exposure gates below are synchronous and reject expired audience
  // evidence; an active long turn renews it from current authority first.
  await renewExpiredTrustedDeliveryAudience(args.runtime, args.message);
  // The candidate surface starts from every runtime action and applies only the
  // same execution gates the planner executor will enforce — it deliberately does
  // NOT pre-filter by `action.contexts` against the messageHandler-picked
  // `selectedContexts`. Context pre-filtering excludes owner actions, CALENDAR,
  // SCHEDULED_TASKS, etc. whenever the messageHandler routes to "general", even
  // when the user clearly asked for a habit/event/etc. Starting from every action
  // keeps role-policy overrides working for deployments that intentionally expose
  // an action outside its declared context, while avoiding dead tools the planner
  // could select but execution would immediately reject.
  const allRuntimeActions = args.runtime.actions;
  const declaredAdmissionDomains = new Set(
    (args.selectedContexts ?? []).map(normalizeContextId),
  );
  const pendingDomains = new Set(
    pendingActionContexts(
      allRuntimeActions,
      args.intents,
      (context) => args.runtime.contexts?.get(context)?.aliases,
    ).filter((context) => !declaredAdmissionDomains.has(context)),
  );
  // Bound additional admission checks before validate()/connector policy can
  // perform I/O. Unknown parent-only families remain explicit discovery work.
  const supplementalNames = new Set(
    pendingDomains.size > 0
      ? retrieveContextualPlannerActions({
          actions: allRuntimeActions.filter(
            (action) =>
              !action.subActions?.length &&
              actionDiscoveryContexts(action).some((context) =>
                pendingDomains.has(normalizeContextId(context)),
              ),
          ),
          query: (args.intents ?? []).join("\n"),
          intents: args.intents,
          contextAliases: (context) =>
            args.runtime.contexts?.get(context)?.aliases,
        }).actions.map((action) => action.name)
      : [],
  );
  const actionLookup = buildRuntimeActionLookup(args.runtime);
  const actionsByName = new Map(
    allRuntimeActions.map((action) => [action.name, action]),
  );
  const actionsByNormalizedName = new Map(
    allRuntimeActions.map((action) => [
      normalizeActionIdentifier(action.name),
      action,
    ]),
  );
  const selectedActions: Action[] = [];
  const explicitActionNames = new Set<string>();
  const seen = new Set<string>();
  const timer = getInferenceTimer();
  type Gate = "connector-policy" | "validate";
  const totals: Record<
    Gate,
    { count: number; totalMs: number; maxMs: number; throws: number }
  > = {
    "connector-policy": { count: 0, totalMs: 0, maxMs: 0, throws: 0 },
    validate: { count: 0, totalMs: 0, maxMs: 0, throws: 0 },
  };
  const checks =
    timer && readEnvBool("ELIZA_INFERENCE_TIMING")
      ? ([] as Array<{
          action: string;
          gate: Gate;
          durationMs: number;
          outcome: "returned" | "threw";
        }>)
      : undefined;
  const discoveryStartedAt = timer ? performance.now() : 0;
  // Default diagnostics have constant cardinality. Complete per-action checks
  // are opt-in and never become model context or change candidate admission.
  const observeCheck = async <T>(
    gate: Gate,
    action: Action,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (!timer) return run();
    const startedAt = performance.now();
    let returned = false;
    try {
      const result = await run();
      returned = true;
      return result;
    } finally {
      const durationMs = performance.now() - startedAt;
      const total = totals[gate];
      total.count++;
      total.totalMs += durationMs;
      total.maxMs = Math.max(total.maxMs, durationMs);
      if (!returned) total.throws++;
      checks?.push({
        action: action.name,
        gate,
        durationMs,
        outcome: returned ? "returned" : "threw",
      });
    }
  };

  const appendIfAllowed = async (
    action: Action,
    parentActionName?: string,
    activeContexts: readonly AgentContext[] | undefined = args.selectedContexts,
    explicitCandidateName?: string,
  ): Promise<boolean> => {
    const normalizedName = normalizeActionIdentifier(action.name);
    if (!normalizedName || seen.has(normalizedName)) {
      return false;
    }
    // One gate for exposure and execution (#12087 Item 9): private-action gate
    // (private actions never reach the planner on a user turn) + ACTION_ROLE_POLICY
    // + contextGate + roleGate, all via the shared chokepoint.
    // Explicit Stage-1 hints need a diagnostic when their resolved action is
    // rejected. The all-action pass stays quiet because ordinary gate misses
    // are expected while building a narrowed surface.
    const gateRejection = actionGateRejection(action, {
      message: args.message,
      activeContexts,
      userRoles: args.userRoles,
    });
    if (gateRejection !== undefined) {
      if (explicitCandidateName) {
        if (gateRejection.kind === "disclosure") {
          args.diagnostics?.disclosureRejectedExplicitCandidates.push(
            action.name,
          );
          args.diagnostics?.disclosureRejectedReasons.push(
            gateRejection.reason,
          );
        } else {
          args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
            action.name,
          );
        }
        args.runtime.logger.warn(
          {
            src: "service:message",
            action: action.name,
            candidate: explicitCandidateName,
            gate: "action-gate",
            reason: gateRejection.reason,
          },
          "Explicit stage-1 candidate rejected at the action gate",
        );
      }
      return false;
    }
    try {
      const accountPolicy = await observeCheck("connector-policy", action, () =>
        evaluateConnectorAccountPolicies(args.runtime, action, {
          message: args.message,
        }),
      );
      if (!accountPolicy.allowed) {
        if (explicitCandidateName) {
          // An account-policy denial is a non-disclosure rejection: record it
          // so a mixed {disclosure + policy} set is visible to the privacy
          // short-circuit's onlyDisclosureRejections conjunct (#20869).
          args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
            action.name,
          );
          args.runtime.logger.warn(
            {
              src: "service:message",
              action: action.name,
              candidate: explicitCandidateName,
              gate: "connector-account-policy",
              reason: accountPolicy.reason,
            },
            "Explicit stage-1 candidate rejected by connector account policy",
          );
        }
        return false;
      }
      if (action.validate) {
        const validate = action.validate;
        // validate() reads the routing state (hasActionContext), so it sees
        // the contexts this action was admitted under — identical state on
        // the ordinary path, widened only for discovery, explicit Stage-1
        // candidates and children admitted under their own contexts.
        const validationState = withActiveRoutingContexts(
          args.state,
          args.message,
          activeContexts,
        );
        const valid = await observeCheck("validate", action, () =>
          validate.call(action, args.runtime, args.message, validationState),
        );
        if (!valid) {
          if (explicitCandidateName) {
            // validate()===false is likewise a non-disclosure rejection
            // (#20869); without this record the mixed set short-circuits to
            // the privacy template — the #20679 mislabel class.
            args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
              action.name,
            );
            args.runtime.logger.warn(
              {
                src: "service:message",
                action: action.name,
                candidate: explicitCandidateName,
                gate: "validate-returned-false",
                reason: `Action ${action.name} is not available for the current state`,
              },
              "Explicit stage-1 candidate rejected by action validate()",
            );
          }
          return false;
        }
      }
      seen.add(normalizedName);
      selectedActions.push(action);
      return true;
    } catch (error) {
      if (explicitCandidateName) {
        // Provider-policy and validate exceptions are fail-closed capability
        // rejections, not disclosure decisions. Preserve that distinction so
        // a sibling disclosure denial cannot mislabel the compound turn as
        // purely private.
        args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
          action.name,
        );
      }
      // error-policy:J1 planner exposure fails closed for the affected action
      // while reporting the validation failure to the agent.
      args.runtime.reportError(
        "MessageService.plannerActionValidation",
        error,
        {
          action: action.name,
          parentAction: parentActionName,
        },
      );
      return false;
    }
  };

  // View metadata changes ordering only. The complete runtime catalog still
  // passes through the ordinary role/context/policy gates, so an ambiguous or
  // cross-view request never loses an otherwise authorized action merely
  // because Stage 1 did not guess its exact name.
  const focusedViewActionNames = uiViewActionNames(args.message);
  const baseRuntimeActions = hasUiViewPlannerScope(args.message)
    ? allRuntimeActions
        .map((action, index) => ({ action, index }))
        .sort((left, right) => {
          const priorityDelta =
            uiViewActionPriority(
              left.action,
              args.selectedContexts,
              focusedViewActionNames,
            ) -
            uiViewActionPriority(
              right.action,
              args.selectedContexts,
              focusedViewActionNames,
            );
          return priorityDelta || left.index - right.index;
        })
        .map(({ action }) => action)
    : allRuntimeActions;
  for (const action of baseRuntimeActions) {
    // Discovery uses the same declared contexts as an explicit candidate hint.
    // Role, disclosure, private-action, connector, and validation gates still run.
    await appendIfAllowed(
      action,
      undefined,
      args.discoverActions || supplementalNames.has(action.name)
        ? actionDiscoveryContexts(action, args.selectedContexts)
        : args.selectedContexts,
    );
  }

  const explicitCandidateActions = Array.isArray(args.candidateActions)
    ? args.candidateActions
    : [];
  for (const candidateName of explicitCandidateActions) {
    // Resolve the synthetic candidate name Stage-1 invents to real actions:
    // first by exact name/simile, then by the shared parent-alias map that
    // retrieval already uses. The alias fallback lets an explicit permission
    // ask surface its writer (SETTINGS) even when Stage-1 mis-scoped the turn's
    // context (e.g. classified "revoke network access for the weather app" as
    // terminal/general): the candidate is an intent hint, so the resolved
    // parent is admitted under ITS OWN contexts — still gated on
    // role/private/context via appendIfAllowed (#14622).
    const direct = resolveRuntimeAction(actionLookup, candidateName);
    let resolved = direct
      ? [direct]
      : parentAliasesForCandidateAction(candidateName)
          .map((alias) => resolveRuntimeAction(actionLookup, alias))
          .filter((action): action is Action => action !== undefined);
    if (resolved.length === 0) {
      // Stage-1 models emit reversed compound names (live 2026-08-19:
      // `CANCEL_TASKS` for `TASKS_CANCEL`). Same tokens, any order — admit
      // only an unambiguous single match; ambiguity keeps the warn below.
      const candidateTokenKey = actionNameTokenKey(candidateName);
      const tokenMatches = allRuntimeActions.filter(
        (action) => actionNameTokenKey(action.name) === candidateTokenKey,
      );
      if (tokenMatches.length === 1) {
        resolved = tokenMatches;
      }
    }
    if (resolved.length === 0) {
      const normalizedCandidate = normalizeActionIdentifier(candidateName);
      if (normalizedCandidate) {
        // A missing capability is another non-disclosure limitation. Recording
        // it keeps a simultaneous disclosure rejection from short-circuiting
        // the planner with an unrelated privacy-only response.
        args.diagnostics?.nonDisclosureRejectedExplicitCandidates.push(
          normalizedCandidate,
        );
      }
      args.runtime.logger.warn(
        {
          src: "service:message",
          candidate: candidateName,
          gate: "resolved-to-no-runtime-action",
        },
        "Explicit stage-1 candidate resolved to no runtime action",
      );
      continue;
    }
    for (const action of resolved) {
      // Preserve exact operations selected through aliases as well as names.
      // The admission/execution gates below still determine their availability.
      explicitActionNames.add(normalizeActionIdentifier(action.name));
      await appendIfAllowed(
        action,
        undefined,
        actionDiscoveryContexts(action, args.selectedContexts),
        candidateName,
      );
    }
  }

  for (let index = 0; index < selectedActions.length; index += 1) {
    const parentAction = selectedActions[index];
    const childActiveContexts = actionDiscoveryContexts(
      parentAction,
      args.selectedContexts,
    );
    for (const subAction of parentAction.subActions ?? []) {
      const childAction =
        typeof subAction === "string"
          ? (actionsByName.get(subAction) ??
            actionsByNormalizedName.get(normalizeActionIdentifier(subAction)))
          : subAction;
      if (!childAction) {
        args.runtime.logger.warn(
          {
            src: "service:message",
            parentAction: parentAction.name,
            subAction,
          },
          "Skipping unresolved sub-action while building planner action surface",
        );
        continue;
      }
      await appendIfAllowed(
        childAction,
        parentAction.name,
        actionDiscoveryContexts(childAction, childActiveContexts),
      );
    }
  }

  if (timer)
    recordInferenceSpan(
      "actions:discovery",
      performance.now() - discoveryStartedAt,
      {
        phase: args.discoverActions ? "discovery" : "planner",
        summary: JSON.stringify(totals),
        ...(checks ? { checks: JSON.stringify(checks) } : {}),
      },
    );
  // A plugin-declared owner that passed every admission gate keeps its
  // replacement authority on the planner/discovery surface, not just Stage 1.
  // A whole-message route does not establish ownership of independent
  // declared outcomes. Keep adjacent capabilities for compound work.
  if ((args.intents?.filter((intent) => intent.trim()).length ?? 0) > 1)
    return selectedActions;
  const replacedActionNames = new Set<string>();
  const currentText = getActionInferenceMessageText(args.message);
  for (const rule of getDirectActionRoutingRules(args.runtime)) {
    if (
      !rule.replacesActionNames?.length ||
      !rule.matches(currentText, args.message)
    )
      continue;
    const ownerNames = new Set(rule.actionNames.map(normalizeActionIdentifier));
    const requiredTags = rule.requiredActionTags.map((tag) =>
      tag.trim().toLowerCase(),
    );
    const ownerAdmitted = selectedActions.some((action) => {
      if (!ownerNames.has(normalizeActionIdentifier(action.name))) return false;
      const tags = new Set(
        (action.tags ?? []).map((tag) => tag.trim().toLowerCase()),
      );
      return requiredTags.every((tag) => tags.has(tag));
    });
    if (ownerAdmitted) {
      for (const name of rule.replacesActionNames) {
        const replaced = normalizeActionIdentifier(name);
        replacedActionNames.add(replaced);
        // A fallback parent can already have promoted children on this surface.
        // Suppress only its registered siblings, not an explicitly named
        // independent operation; unknown families retain exact-name behavior.
        const parent = actionsByNormalizedName.get(replaced);
        for (const child of parent?.subActions ?? []) {
          const childName = normalizeActionIdentifier(
            typeof child === "string" ? child : child.name,
          );
          if (!explicitActionNames.has(childName))
            replacedActionNames.add(childName);
        }
      }
    }
  }
  return selectedActions.filter(
    (action) =>
      !replacedActionNames.has(normalizeActionIdentifier(action.name)),
  );
}

export function stringArrayProperty(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

/** Build a discovery candidate's routing terms without weakening its canonical gate.
 * Optional alternatives forbidden by noneOf are not activated. Required allOf
 * terms stay intact so contradictory gates fail closed, as do already-active
 * forbidden contexts. Roles, disclosure and account policy are checked separately.
 */
export function actionDiscoveryContexts(
  action: Action,
  activeContexts?: readonly AgentContext[],
): AgentContext[] {
  const gate = action.contextGate;
  const denied = new Set((gate?.noneOf ?? []).map(normalizeContextId));
  const alternatives = [
    ...(gate?.contexts ?? action.contexts ?? []),
    ...(gate?.anyOf ?? []),
  ].filter((context) => !denied.has(normalizeContextId(context)));
  return mergeAgentContexts(activeContexts, alternatives, gate?.allOf);
}

export function mergeAgentContexts(
  ...lists: Array<readonly AgentContext[] | undefined>
): AgentContext[] {
  const seen = new Set<string>();
  const merged: AgentContext[] = [];
  for (const list of lists) {
    for (const context of list ?? []) {
      const id = String(context);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(context);
    }
  }
  return merged;
}

/**
 * The agent contexts a focused per-turn coding loop is considered to be
 * operating in.
 * Used to admit the coding tools (FILE/SHELL/WORKTREE gate on these) while the
 * messaging/social chat actions stay gated off.
 */
export const CODING_SUB_AGENT_CONTEXTS: readonly AgentContext[] = [
  "code",
  "files",
  "terminal",
  "automation",
];

export function actionNameTokenKey(name: string): string {
  return normalizeActionName(name).split("_").filter(Boolean).sort().join("_");
}

export function getMessageHandlerCandidateActions(
  messageHandler: MessageHandlerResult,
): string[] {
  return stringArrayProperty(
    (messageHandler.plan as { candidateActions?: unknown }).candidateActions,
  );
}

// The two stage-1 plan fields the escalation predicates read as plain values.
// `candidateActions` stays per call site because the backstop path cleans it
// through `getMessageHandlerCandidateActions` while the evaluator path forwards
// the raw list. A stage-1 plan legitimately may carry no contexts and no reply,
// so an absent optional field normalizes to the empty shape those pure
// predicates already treat as "nothing there" — normalized here once instead of
// at every call site.
/**
 * Choose the honest decline for a gated owner-private ask, driven by the actual
 * gate-failure reason instead of a single hardcoded line. The old fixed reply
 * ("ask me in a DM") is correct ONLY when the asker is the owner on a shared
 * surface — for a genuine non-owner it is misleading advice, since a DM would
 * be denied too. Reasons come from `actionGateFailure` and end in the disclosure
 * decision reason (`participant_mismatch`, `owner_mismatch`, …).
 *
 *  - owner on a group/shared surface (`participant_mismatch` /
 *    `destination_not_private`) → the DM routing hint is accurate.
 *  - not the owner (`owner_mismatch`) → a permission-truthful decline with NO
 *    DM hint, because access, not surface, is missing.
 */
export function privacyDenialReplyForReasons(
  reasons: readonly string[],
): string {
  const joined = reasons.join(" | ").toLowerCase();
  const ownerOnWrongSurface =
    /participant_mismatch|destination_not_private/.test(joined);
  const notTheOwner = /owner_mismatch/.test(joined);
  // Owner-on-a-group takes precedence when multiple disclosure-gated candidates
  // fail for different audience reasons.
  if (ownerOnWrongSurface && !notTheOwner) {
    return "that's private, so i can't pull it up in a shared channel — ask me in a DM and i'll handle it there.";
  }
  if (notTheOwner) {
    return "that's the owner's private info, so i can't share it — it's only available to them.";
  }
  return "i can't share that private information in this conversation.";
}

export function messageHandlerStageOneReplyContexts(
  messageHandler: MessageHandlerResult,
): {
  stageOneContexts: readonly string[];
  stageOneReplyText: string;
  stageOneReplyEffectStatus: MessageHandlerResult["plan"]["replyEffectStatus"];
  stageOneIntents: readonly string[];
} {
  return {
    stageOneContexts: messageHandler.plan.contexts ?? [],
    stageOneReplyText: String(messageHandler.plan.reply ?? ""),
    stageOneReplyEffectStatus: messageHandler.plan.replyEffectStatus,
    stageOneIntents: messageHandler.plan.intents ?? [],
  };
}

export function getMessageHandlerParentActionHints(
  messageHandler: MessageHandlerResult,
): string[] {
  return stringArrayProperty(
    (messageHandler.plan as { parentActionHints?: unknown }).parentActionHints,
  );
}

export function buildFullV5PlannerActionSurface(params: {
  actions: readonly Action[];
  candidateActions?: readonly string[];
  parentActionHints?: readonly string[];
  codingActionProfile?: CodingActionProfile;
}): V5PlannerActionSurface {
  const exposedActionNames = new Set(
    params.actions.map((action) => normalizeActionIdentifier(action.name)),
  );
  return {
    exposedActionNames,
    summary: {
      mode: "full",
      candidateActionCount: params.actions.length,
      catalogParentCount: params.actions.length,
      exposedActionCount: exposedActionNames.size,
      tierAParents: params.actions.map((action) => action.name).sort(),
      tierBParents: [],
      omittedParentCount: 0,
      omittedParentNamesPreview: [],
      warnings: 0,
      queryTokenCount: 0,
      candidateActions: [...(params.candidateActions ?? [])],
      parentActionHints: [...(params.parentActionHints ?? [])],
      ...(params.codingActionProfile
        ? {
            codingActionProfile: {
              kind: params.codingActionProfile.kind,
              includeWorktree:
                params.codingActionProfile.includeWorktree === true,
            },
          }
        : {}),
    },
  };
}

export function buildV5PlannerActionSurface(params: {
  actions: readonly Action[];
  forceFullSurface?: boolean;
  codingActionProfile?: CodingActionProfile;
  message: Memory;
  state?: State;
  messageHandler: MessageHandlerResult;
  /** @deprecated Candidate hints rank tools but never remove authorized tools. */
  restrictToCandidateActions?: boolean;
  // The messageHandler-selected contexts for this turn. Passed through to
  // `retrieveActions` as a *weight* (boost on-context candidates) — never
  // as a filter. See `services/collectV5PlannerCandidateActions` for why
  // we stopped filtering by context.
  selectedContexts?: readonly AgentContext[];
  // Optional recorder hook. When provided the function emits a `toolSearch`
  // stage to the trajectory before returning. Fire-and-forget — the caller
  // does not need to await.
  recorder?: TrajectoryRecorder;
  trajectoryId?: string;
  logger?: IAgentRuntime["logger"];
  reportError?: IAgentRuntime["reportError"];
  // Optional locale-aware example swapper. Resolved by the caller (which
  // has async access to `OwnerFactStore.locale`) and passed through to
  // `buildActionCatalog` so the planner sees localized `ActionExample`
  // pairs at catalog-build time.
  localizedExamples?: LocalizedActionExampleResolver;
}): V5PlannerActionSurface {
  const candidateActions = getMessageHandlerCandidateActions(
    params.messageHandler,
  );
  const parentActionHints = getMessageHandlerParentActionHints(
    params.messageHandler,
  );

  // An explicitly forced surface retains the historical summary mode, but both
  // paths preserve every authorized action. Retrieval and tier metadata only
  // order and describe the complete catalog.
  // A task_complete relay's only job is delivering the finished result. Any
  // catalog tool on this synthetic turn invites task-management
  // improvisation over the completed work (live 2026-08-19: the planner
  // ARCHIVED the just-completed task and told the user "Archived" instead
  // of relaying the result). Protocol tools (REPLY/IGNORE/STOP) remain.
  // Blocked/question/coordination relays keep the full surface — those turns
  // may legitimately act (answer a child, coordinate a sibling).
  if (isTaskCompleteRelayTurn(params.message)) {
    return {
      exposedActionNames: new Set<string>(),
      summary: {
        mode: "relay-delivery",
        candidateActionCount: params.actions.length,
        catalogParentCount: 0,
        exposedActionCount: 0,
        tierAParents: [],
        tierAChildrenByParent: {},
        tierBParents: [],
        omittedParentCount: 0,
        omittedParentNamesPreview: [],
        actionSurfaceHash: "relay-delivery",
        warnings: 0,
        queryTokenCount: 0,
        candidateActions: [],
        parentActionHints: [],
        ...(params.codingActionProfile
          ? {
              codingActionProfile: {
                kind: params.codingActionProfile.kind,
                includeWorktree:
                  params.codingActionProfile.includeWorktree === true,
              },
            }
          : {}),
      },
    };
  }
  const forceFullSurface =
    params.forceFullSurface === true || params.actions.length === 0;
  if (forceFullSurface) {
    return buildFullV5PlannerActionSurface({
      actions: params.actions,
      candidateActions,
      parentActionHints,
      codingActionProfile: params.codingActionProfile,
    });
  }

  const toolSearchStartedAt = Date.now();
  const authorizedActionIdentities = new Set(
    params.actions.map((action) => action.name.trim()),
  );
  const authorizedActionNames = new Set(
    params.actions.map((action) => normalizeActionIdentifier(action.name)),
  );
  // A parent may retain inline metadata for every registered child even when
  // this turn's action gate rejected one of those children. Build retrieval and
  // tier metadata from the authorized view so a denied child's name,
  // description, schema, or examples cannot influence or enter model context.
  const authorizedCatalogActions = params.actions.map((action) => ({
    ...action,
    subActions: action.subActions?.filter((child) => {
      const childName = typeof child === "string" ? child : child.name;
      // Authorization uses the exact native tool identity. The retrieval
      // normalizer intentionally collapses separators, so using it here would
      // let an allowed FOO_BAR disclose a denied FOOBAR child (or vice versa).
      return authorizedActionIdentities.has(childName.trim());
    }),
  }));
  const catalogStartedAt = performance.now();
  const catalog = buildActionCatalog(authorizedCatalogActions, {
    localizedExamples: params.localizedExamples,
  });
  recordInferenceSpan("actions:catalog", performance.now() - catalogStartedAt, {
    actions: authorizedCatalogActions.length,
    parents: catalog.parents.length,
  });
  const measurementMode = process.env.ELIZA_RETRIEVAL_MEASUREMENT === "1";
  const messageText = getUserMessageText(params.message);
  if (typeof messageText !== "string") {
    params.logger?.warn(
      {
        src: "service:message",
        messageId: params.message.id,
      },
      "Planner action retrieval received message without text",
    );
  }
  const retrievalMessageText =
    typeof messageText === "string" ? messageText : "";
  const retrievalStartedAt = performance.now();
  const retrieval = retrieveActions({
    catalog,
    messageText: retrievalMessageText,
    intents: params.messageHandler.plan.intents,
    recentConversationText: getRecentConversationSearchText(
      params.state,
      params.message,
    ),
    selectedContexts: params.selectedContexts,
    candidateActions,
    parentActionHints,
    measurementMode,
  });
  recordInferenceSpan(
    "actions:retrieval",
    performance.now() - retrievalStartedAt,
  );
  const tieringStartedAt = performance.now();
  const tieredSurface = tierActionResults({
    catalog,
    results: retrieval.results,
  });
  recordInferenceSpan("actions:tiering", performance.now() - tieringStartedAt);
  const toolSearchEndedAt = Date.now();
  const exposedActionNames = authorizedActionNames;
  const tierAChildrenByParent = Object.fromEntries(
    tieredSurface.tierAParents.map((parent) => [
      parent.name,
      parent.childNames.filter((childName) =>
        authorizedActionIdentities.has(childName.trim()),
      ),
    ]),
  );
  const exposedActionCount = params.actions.filter((action) =>
    exposedActionNames.has(normalizeActionIdentifier(action.name)),
  ).length;

  if (params.recorder && params.trajectoryId) {
    const stageId = `stage-toolsearch-${toolSearchStartedAt}`;
    const trajectoryId = params.trajectoryId;
    void params.recorder
      .recordStage(trajectoryId, {
        stageId,
        kind: "toolSearch",
        startedAt: toolSearchStartedAt,
        endedAt: toolSearchEndedAt,
        latencyMs: toolSearchEndedAt - toolSearchStartedAt,
        toolSearch: {
          query: {
            text: retrievalMessageText,
            tokens: retrieval.query.tokens,
            candidateActions: [...candidateActions],
            parentActionHints: [...parentActionHints],
          },
          results: retrieval.results.map((r, idx) => ({
            name: r.name,
            score: r.score,
            rank: idx,
            rrfScore: r.rrfScore,
            matchedBy: r.matchedBy,
            // stageScores is Partial<Record<RetrievalStageName, number>>;
            // the telemetry field is the structurally-identical
            // Record<string, number>, so a plain cast is enough.
            stageScores: r.stageScores as Record<string, number>,
          })),
          tier: {
            tierA: tieredSurface.sortedTierAParentNames,
            tierB: [],
            omitted: 0,
          },
          durationMs: toolSearchEndedAt - toolSearchStartedAt,
          ...(retrieval.measurement
            ? {
                perStageScores: retrieval.measurement.perStageScores,
                fusedTopK: retrieval.measurement.fusedTopK,
              }
            : {}),
        },
      })
      .catch((err) => {
        // error-policy:J7 Tool-search recording is diagnostic; report the
        // missing stage without changing the selected action surface.
        params.reportError?.("MessageService.toolSearchStage", err, {
          trajectoryId,
        });
        params.logger?.warn?.(
          { err: (err as Error).message, trajectoryId },
          "[TrajectoryRecorder] failed to record toolSearch stage",
        );
      });
  }

  return {
    exposedActionNames,
    summary: {
      mode: "tiered",
      candidateActionCount: params.actions.length,
      catalogParentCount: catalog.parents.length,
      exposedActionCount,
      tierAParents: tieredSurface.sortedTierAParentNames,
      tierAChildrenByParent,
      tierBParents: [],
      omittedParentCount: 0,
      omittedParentNamesPreview: [],
      actionSurfaceHash: tieredSurface.actionSurfaceHash,
      warnings: catalog.warnings.length,
      queryTokenCount: retrieval.query.tokens.length,
      candidateActions,
      parentActionHints,
      ...(params.codingActionProfile
        ? {
            codingActionProfile: {
              kind: params.codingActionProfile.kind,
              includeWorktree:
                params.codingActionProfile.includeWorktree === true,
            },
          }
        : {}),
    },
  };
}
