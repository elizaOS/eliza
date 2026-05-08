import type { Action, Content, Memory, Provider, State } from "@elizaos/core";

export const AVAILABLE_CONTEXTS_STATE_KEY = "availableContexts";
export const CONTEXT_ROUTING_METADATA_KEY = "__responseContext";

const LIST_SPLIT_RE = /[\n,;]/;

export const AGENT_CONTEXTS = [
  "general",
  "wallet",
  "documents",
  "browser",
  "code",
  "media",
  "automation",
  "social",
  "system",
] as const;

export type AgentContext = (typeof AGENT_CONTEXTS)[number];

export interface ContextRoutingDecision {
  primaryContext?: AgentContext;
  secondaryContexts?: AgentContext[];
}

const ACTION_CONTEXT_MAP: Record<string, AgentContext[]> = {
  NONE: ["general"],
  IGNORE: ["general"],
  CONTINUE: ["general"],
  REPLY: ["general"],
  HELP: ["general"],
  STATUS: ["general"],
  MODELS: ["general"],
  CONFIGURE: ["general", "system"],
  SEND_TOKEN: ["wallet"],
  TRANSFER: ["wallet"],
  CHECK_BALANCE: ["wallet"],
  GET_BALANCE: ["wallet"],
  SWAP_TOKEN: ["wallet", "automation"],
  BRIDGE_TOKEN: ["wallet"],
  APPROVE_TOKEN: ["wallet"],
  SIGN_MESSAGE: ["wallet"],
  DEPLOY_CONTRACT: ["wallet", "code"],
  CREATE_GOVERNANCE_PROPOSAL: ["wallet", "social"],
  VOTE_ON_PROPOSAL: ["wallet", "social"],
  STAKE: ["wallet"],
  UNSTAKE: ["wallet"],
  CLAIM_REWARDS: ["wallet"],
  GET_TOKEN_PRICE: ["wallet", "documents"],
  GET_PORTFOLIO: ["wallet"],
  CREATE_WALLET: ["wallet"],
  IMPORT_WALLET: ["wallet"],
  DOCUMENT: ["documents"],
  DOCUMENT: ["documents"],
  REMEMBER: ["documents"],
  RECALL: ["documents"],
  LEARN_FROM_EXPERIENCE: ["documents"],
  SEARCH_WEB: ["documents", "browser"],
  WEB_SEARCH: ["documents", "browser"],
  SUMMARIZE: ["documents"],
  ANALYZE: ["documents"],
  BROWSE: ["browser"],
  SCREENSHOT: ["browser", "media"],
  NAVIGATE: ["browser"],
  CLICK: ["browser"],
  TYPE_TEXT: ["browser"],
  EXTRACT_PAGE: ["browser", "documents"],
  SPAWN_AGENT: ["code", "automation"],
  KILL_AGENT: ["code", "automation"],
  UPDATE_AGENT: ["code", "system"],
  RUN_SCRIPT: ["code", "automation"],
  REVIEW_CODE: ["code"],
  GENERATE_CODE: ["code"],
  EXECUTE_TASK: ["code", "automation"],
  CREATE_SUBTASK: ["code", "automation"],
  COMPLETE_TASK: ["code", "automation"],
  CANCEL_TASK: ["code", "automation"],
  GENERATE_MEDIA: ["media"],
  DESCRIBE_IMAGE: ["media", "documents"],
  DESCRIBE_VIDEO: ["media", "documents"],
  DESCRIBE_AUDIO: ["media", "documents"],
  TEXT_TO_SPEECH: ["media"],
  TRANSCRIBE: ["media", "documents"],
  UPLOAD_FILE: ["media"],
  CREATE_CRON: ["automation"],
  UPDATE_CRON: ["automation"],
  DELETE_CRON: ["automation"],
  LIST_CRONS: ["automation"],
  PAUSE_CRON: ["automation"],
  TRIGGER_WEBHOOK: ["automation"],
  SCHEDULE: ["automation"],
  SEND_MESSAGE: ["social"],
  ADD_CONTACT: ["social"],
  UPDATE_CONTACT: ["social"],
  GET_CONTACT: ["social"],
  SEARCH_CONTACTS: ["social"],
  ELEVATE_TRUST: ["social", "system"],
  REVOKE_TRUST: ["social", "system"],
  BLOCK_USER: ["social", "system"],
  UNBLOCK_USER: ["social", "system"],
  MANAGE_PLUGINS: ["system"],
  MANAGE_SECRETS: ["system"],
  SHELL_EXEC: ["system", "code"],
  RESTART: ["system"],
  CONFIGURE_RUNTIME: ["system"],
  SEARCH_ACTIONS: ["system", "documents"],
  FINISH: ["general"],
};

function normalizeContext(value: unknown): AgentContext | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  return AGENT_CONTEXTS.includes(trimmed as AgentContext) ? (trimmed as AgentContext) : undefined;
}

function dedupeStringValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }

    seen.add(lower);
    result.push(trimmed);
  }

  return result;
}

function parseDelimitedList(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return dedupeStringValues(
      value.flatMap((entry) =>
        typeof entry === "string" ? entry.split(LIST_SPLIT_RE) : [String(entry)],
      ),
    );
  }

  if (typeof value === "string") {
    return dedupeStringValues(value.split(LIST_SPLIT_RE));
  }

  return [];
}

export function parseContextList(value: unknown): AgentContext[] {
  return parseDelimitedList(value)
    .map((entry) => normalizeContext(entry))
    .filter((entry): entry is AgentContext => Boolean(entry));
}

export function parseContextRoutingMetadata(raw: unknown): ContextRoutingDecision {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const value = raw as Record<string, unknown>;
  const contexts = parseContextList(value.contexts);
  const primaryContext = normalizeContext(value.primaryContext) ?? contexts[0];
  const secondaryContextSet = new Set<AgentContext>();
  for (const context of [...parseContextList(value.secondaryContexts), ...contexts.slice(1)]) {
    if (context !== primaryContext) {
      secondaryContextSet.add(context);
    }
  }
  const secondaryContexts = [...secondaryContextSet];

  return {
    primaryContext,
    secondaryContexts,
  };
}

export function getContextRoutingFromMessage(message: Memory): ContextRoutingDecision {
  const metadata = message.content?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  return parseContextRoutingMetadata(
    (metadata as Record<string, unknown>)[CONTEXT_ROUTING_METADATA_KEY],
  );
}

export function getActiveRoutingContexts(routing: ContextRoutingDecision): AgentContext[] {
  const contextSet = new Set<AgentContext>(["general"]);

  if (routing.primaryContext) {
    contextSet.add(routing.primaryContext);
  }

  for (const context of routing.secondaryContexts ?? []) {
    contextSet.add(context);
  }

  return [...contextSet];
}

export function setContextRoutingMetadata(message: Memory, routing: ContextRoutingDecision): void {
  const existingMetadata =
    message.content && typeof message.content.metadata === "object"
      ? (message.content.metadata as Record<string, unknown>)
      : {};

  if (!message.content || typeof message.content !== "object") {
    return;
  }

  message.content = {
    ...(message.content as Record<string, unknown>),
    metadata: {
      ...existingMetadata,
      [CONTEXT_ROUTING_METADATA_KEY]: routing,
    },
  } as unknown as Content;
}

export function resolveActionContexts(action: Action): AgentContext[] {
  const declared = parseContextList((action as { contexts?: unknown }).contexts);
  if (declared.length > 0) {
    return declared;
  }

  return ACTION_CONTEXT_MAP[action.name.toUpperCase()] ?? ["general"];
}

export function deriveAvailableContexts(actions: Action[], providers: Provider[]): AgentContext[] {
  const contexts = new Set<AgentContext>(["general"]);

  for (const action of actions) {
    for (const context of resolveActionContexts(action)) {
      contexts.add(context);
    }
  }

  void providers;

  return [...contexts].sort((left, right) => left.localeCompare(right));
}

export function attachAvailableContexts(
  state: State,
  runtime: { actions: Action[]; providers: Provider[] },
): State {
  const availableContexts = deriveAvailableContexts(runtime.actions, runtime.providers);

  return {
    ...state,
    values: {
      ...(state.values ?? {}),
      [AVAILABLE_CONTEXTS_STATE_KEY]: availableContexts.join(", "),
    },
  };
}

export function filterActionsByRouting(
  actions: Action[],
  routing: ContextRoutingDecision,
): Action[] {
  const activeContexts = getActiveRoutingContexts(routing);

  if (activeContexts.length === 1 && activeContexts[0] === "general") {
    return actions;
  }

  const activeContextSet = new Set(activeContexts);

  return actions.filter((action) =>
    resolveActionContexts(action).some((context) => activeContextSet.has(context)),
  );
}
