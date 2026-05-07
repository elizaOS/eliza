import type {
  Action,
  ActionParameters,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Logger,
  Memory,
  State,
} from "@elizaos/core";
import type { SessionInfo } from "./pty-types.js";
import type { RecommendedSkill } from "./skill-recommender.js";

const LOG_PREFIX = "[LifeOpsContextBroker]";

export const LIFEOPS_CONTEXT_BROKER_SLUG = "lifeops-context";

export const LIFEOPS_CONTEXT_BROKER_MANIFEST_ENTRY = {
  slug: LIFEOPS_CONTEXT_BROKER_SLUG,
  name: "LifeOps Context Broker",
  description:
    "Task-scoped parent broker for owner LifeOps context. Supports email, calendar, inbox/priority, contacts, scratchpad when available, and generic cross-channel search/context.",
  guidance:
    'Use only when task-relevant personal context is needed. Example: `USE_SKILL lifeops-context {"category":"email","query":"contract from Alex","limit":5}`. Categories: email, calendar, inbox, priority, contacts, scratchpad, search, context.',
} as const;

type LifeOpsBrokerCategory =
  | "email"
  | "calendar"
  | "inbox"
  | "priority"
  | "contacts"
  | "scratchpad"
  | "search"
  | "context";

interface LifeOpsContextBrokerArgs {
  category?: string;
  query?: string;
  intent?: string;
  person?: string;
  channels?: string[];
  limit?: number;
  startIso?: string;
  endIso?: string;
}

export interface LifeOpsContextBrokerRequest {
  runtime: IAgentRuntime;
  sessionId: string;
  session?: SessionInfo;
  args: unknown;
}

interface BrokerPlan {
  category: LifeOpsBrokerCategory;
  actionNames: string[];
  parameters: ActionParameters;
  intent: string;
  requiresQuery?: boolean;
}

interface RuntimeWithActions {
  actions?: Action[];
}

function getLogger(runtime: IAgentRuntime): Logger | undefined {
  return (runtime as IAgentRuntime & { logger?: Logger }).logger;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return Math.min(value, 25);
}

function normalizeChannels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const channels = value
    .map((item) => normalizeString(item)?.toLowerCase())
    .filter((item): item is string => Boolean(item));
  return channels.length > 0 ? Array.from(new Set(channels)) : undefined;
}

function compactParameters(input: Record<string, unknown>): ActionParameters {
  const out: ActionParameters = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const compacted = value.filter((item) => item !== undefined);
      if (compacted.length > 0) {
        out[key] = compacted as ActionParameters[string];
      }
      continue;
    }
    if (value && typeof value === "object") {
      const nested = compactParameters(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) {
        out[key] = nested;
      }
      continue;
    }
    out[key] = value as ActionParameters[string];
  }
  return out;
}

function normalizeArgs(raw: unknown): LifeOpsContextBrokerArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    category: normalizeString(record.category),
    query: normalizeString(record.query),
    intent: normalizeString(record.intent),
    person: normalizeString(record.person),
    channels: normalizeChannels(record.channels),
    limit: normalizeLimit(record.limit),
    startIso: normalizeString(record.startIso),
    endIso: normalizeString(record.endIso),
  };
}

function normalizeCategory(value: unknown): LifeOpsBrokerCategory | undefined {
  const normalized = normalizeString(value)
    ?.toLowerCase()
    .replace(/[_\s]+/g, "-");
  switch (normalized) {
    case "email":
    case "mail":
    case "gmail":
      return "email";
    case "calendar":
    case "schedule":
    case "events":
      return "calendar";
    case "inbox":
    case "messages":
      return "inbox";
    case "priority":
    case "priorities":
    case "urgent":
      return "priority";
    case "contact":
    case "contacts":
    case "relationship":
    case "relationships":
    case "rolodex":
      return "contacts";
    case "scratchpad":
    case "notes":
      return "scratchpad";
    case "search":
    case "generic-search":
    case "cross-channel-search":
      return "search";
    case "context":
    case "generic-context":
      return "context";
    default:
      return undefined;
  }
}

function inferCategory(args: LifeOpsContextBrokerArgs): LifeOpsBrokerCategory {
  const explicit = normalizeCategory(args.category);
  if (explicit) return explicit;
  const haystack = [args.intent, args.query]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\b(gmail|email|mail)\b/.test(haystack)) return "email";
  if (/\b(calendar|schedule|meeting|event)\b/.test(haystack)) return "calendar";
  if (/\b(inbox|message|dm|urgent|priority)\b/.test(haystack)) {
    return /\b(urgent|priority)\b/.test(haystack) ? "priority" : "inbox";
  }
  if (/\b(contact|contacts|rolodex|relationship)\b/.test(haystack)) {
    return "contacts";
  }
  if (/\b(scratchpad|note|notes)\b/.test(haystack)) return "scratchpad";
  return args.query ? "search" : "context";
}

function createPlan(args: LifeOpsContextBrokerArgs): BrokerPlan {
  const category = inferCategory(args);
  const intent =
    args.intent ??
    args.query ??
    `LifeOps context broker request for ${category}`;

  switch (category) {
    case "email":
      return {
        category,
        actionNames: args.query
          ? ["SEARCH_MESSAGES", "TRIAGE_MESSAGES"]
          : ["TRIAGE_MESSAGES"],
        intent,
        parameters: compactParameters({
          channel: "gmail",
          query: args.query,
          intent,
        }),
      };
    case "calendar":
      return {
        category,
        actionNames: ["OWNER_CALENDAR"],
        intent,
        parameters: compactParameters({
          subaction: args.query ? "search_events" : "feed",
          query: args.query,
          queries: args.query ? [args.query] : undefined,
          intent,
          details: {
            startIso: args.startIso,
            endIso: args.endIso,
          },
        }),
      };
    case "inbox":
    case "priority":
      return {
        category,
        actionNames:
          category === "priority"
            ? ["OWNER_CHECKIN", "LIST_INBOX"]
            : ["TRIAGE_MESSAGES"],
        intent,
        parameters: compactParameters({
          channel: "all",
          query: args.query,
          intent,
        }),
      };
    case "contacts":
      return {
        category,
        actionNames: ["OWNER_RELATIONSHIP"],
        intent,
        parameters: compactParameters({
          subaction: "list_contacts",
          intent,
          name: args.person ?? args.query,
        }),
      };
    case "scratchpad":
      return {
        category,
        actionNames: [
          "SCRATCHPAD_SEARCH",
          "KNOWLEDGE_SCRATCHPAD",
          "SCRATCHPAD",
        ],
        intent,
        parameters: compactParameters({
          query: args.query ?? intent,
          limit: args.limit,
        }),
        requiresQuery: true,
      };
    case "search":
    case "context":
      return {
        category,
        actionNames: ["SEARCH_MESSAGES"],
        intent,
        parameters: compactParameters({
          query: args.query,
          intent,
          person: args.person,
          channels: args.channels,
          limit: args.limit,
          startIso: args.startIso,
          endIso: args.endIso,
        }),
        requiresQuery: category === "search",
      };
  }
}

function resolveRuntimeAction(
  runtime: IAgentRuntime,
  actionNames: readonly string[],
): Action | null {
  const actions = (runtime as RuntimeWithActions).actions;
  if (!Array.isArray(actions)) return null;
  const wanted = new Set(actionNames);

  for (const action of actions) {
    if (action?.name && wanted.has(action.name)) return action;
  }
  for (const action of actions) {
    if (action?.similes?.some((simile) => wanted.has(simile))) {
      return action;
    }
  }
  return null;
}

function buildBrokerMessage(args: {
  runtime: IAgentRuntime;
  sessionId: string;
  session?: SessionInfo;
  text: string;
}): Memory {
  const metadata = args.session?.metadata;
  const runtimeAgentId = (args.runtime as IAgentRuntime & { agentId?: string })
    .agentId;
  const entityId =
    normalizeString(metadata?.userId) ??
    normalizeString(runtimeAgentId) ??
    `child-session:${args.sessionId}`;
  const roomId =
    normalizeString(metadata?.roomId) ??
    normalizeString(metadata?.threadId) ??
    `child-session:${args.sessionId}`;
  const worldId = normalizeString(metadata?.worldId);
  const source = normalizeString(metadata?.source) ?? "skill-lifeops-context";

  return {
    content: { text: args.text, source },
    entityId,
    roomId,
    ...(worldId ? { worldId } : {}),
  } as unknown as Memory;
}

function extractResultText(
  result: ActionResult | undefined | null,
  captured: readonly string[],
): string {
  if (typeof result?.text === "string" && result.text.trim()) {
    return result.text.trim();
  }
  const capturedText = captured.join("\n").trim();
  if (capturedText) return capturedText;
  if (result?.data !== undefined) {
    return formatContextData(result.data);
  }
  return "(no LifeOps context returned)";
}

function formatContextData(value: unknown, indent = 0): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const formatted = formatContextData(item, indent + 2);
        return `${pad}- ${formatted.replace(/\n/g, `\n${pad}  `)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const formatted = formatContextData(entry, indent + 2);
        return formatted.includes("\n")
          ? `${pad}${key}:\n${formatted}`
          : `${pad}${key}: ${formatted}`;
      })
      .join("\n");
  }
  return String(value);
}

function unsupportedText(plan: BrokerPlan): string {
  if (plan.category === "scratchpad") {
    return (
      "Scratchpad context is not available in this parent runtime. " +
      "Remaining app-level broker endpoint needed: expose a read-only parent action for `/api/knowledge/scratchpad/search?query=<query>&limit=<n>` or register an equivalent SCRATCHPAD_SEARCH action."
    );
  }
  return (
    `LifeOps context category \`${plan.category}\` is not available in this parent runtime. ` +
    `Expected one of these parent actions: ${plan.actionNames.join(", ")}.`
  );
}

async function invokeAction(args: {
  runtime: IAgentRuntime;
  action: Action;
  message: Memory;
  parameters: ActionParameters;
}): Promise<{ result: ActionResult | undefined | null; captured: string[] }> {
  if (typeof args.action.handler !== "function") {
    return {
      result: {
        success: false,
        text: `Parent action ${args.action.name} has no handler.`,
      },
      captured: [],
    };
  }

  const captured: string[] = [];
  const callback: HandlerCallback = async (content) => {
    if (typeof content?.text === "string" && content.text.trim()) {
      captured.push(content.text.trim());
    }
    return [];
  };
  const options: HandlerOptions = { parameters: args.parameters };
  const result = (await args.action.handler(
    args.runtime,
    args.message,
    undefined as State | undefined,
    options,
    callback,
  )) as ActionResult | undefined | null;
  return { result, captured };
}

export async function runLifeOpsContextBroker(
  request: LifeOpsContextBrokerRequest,
): Promise<ActionResult> {
  const log = getLogger(request.runtime);
  const parsedArgs = normalizeArgs(request.args);
  const plan = createPlan(parsedArgs);

  log?.info?.(
    {
      src: LOG_PREFIX,
      event: "request",
      sessionId: request.sessionId,
      category: plan.category,
      hasQuery: Boolean(parsedArgs.query),
      hasPerson: Boolean(parsedArgs.person),
      channelCount: parsedArgs.channels?.length ?? 0,
    },
    `${LOG_PREFIX} broker request`,
  );

  if (plan.requiresQuery && !parsedArgs.query && plan.category !== "context") {
    const text = `LifeOps context category \`${plan.category}\` requires a \`query\` argument.`;
    return {
      success: false,
      text,
      data: {
        actionName: LIFEOPS_CONTEXT_BROKER_SLUG,
        category: plan.category,
      },
    };
  }

  const action = resolveRuntimeAction(request.runtime, plan.actionNames);
  if (!action) {
    const text = unsupportedText(plan);
    log?.warn?.(
      {
        src: LOG_PREFIX,
        event: "unavailable",
        sessionId: request.sessionId,
        category: plan.category,
        expectedActions: plan.actionNames,
      },
      `${LOG_PREFIX} broker category unavailable`,
    );
    return {
      success: false,
      text,
      data: {
        actionName: LIFEOPS_CONTEXT_BROKER_SLUG,
        category: plan.category,
      },
    };
  }

  const message = buildBrokerMessage({
    runtime: request.runtime,
    sessionId: request.sessionId,
    session: request.session,
    text: plan.intent,
  });

  try {
    const { result, captured } = await invokeAction({
      runtime: request.runtime,
      action,
      message,
      parameters: plan.parameters,
    });
    const success = result?.success !== false;
    const text = [
      `LifeOps context broker (${plan.category}) via ${action.name}:`,
      extractResultText(result, captured),
    ].join("\n\n");

    log?.info?.(
      {
        src: LOG_PREFIX,
        event: "result",
        sessionId: request.sessionId,
        category: plan.category,
        actionName: action.name,
        success,
      },
      `${LOG_PREFIX} broker result`,
    );

    return {
      success,
      text,
      data: {
        actionName: LIFEOPS_CONTEXT_BROKER_SLUG,
        category: plan.category,
        delegatedAction: action.name,
        result: result?.data,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Unknown error: ${String(error)}`;
    log?.error?.(
      {
        src: LOG_PREFIX,
        event: "error",
        sessionId: request.sessionId,
        category: plan.category,
        actionName: action.name,
        error: message,
      },
      `${LOG_PREFIX} broker action failed`,
    );
    return {
      success: false,
      text: `LifeOps context broker failed via ${action.name}: ${message}`,
      data: {
        actionName: LIFEOPS_CONTEXT_BROKER_SLUG,
        category: plan.category,
        delegatedAction: action.name,
      },
    };
  }
}

const EXPLICIT_BROKER_RE =
  /\b(lifeops-context|lifeops context broker|parent lifeops|use_skill\s+lifeops-context|ask the parent for lifeops|personal context broker)\b/i;
const PERSONAL_CONTEXT_RE =
  /\b(my|owner'?s|user'?s|personal)\s+(email|gmail|calendar|schedule|inbox|messages|contacts|rolodex|scratchpad|notes|day|lifeops)\b/i;
const LIFEOPS_CONTEXT_RE =
  /\blifeops\b.{0,80}\b(context|email|gmail|calendar|schedule|inbox|priority|contacts|rolodex|scratchpad|search)\b/i;
const CODING_TASK_RE =
  /\b(implement|fix|refactor|test|typecheck|lint|build|code|repo|repository|pull request|workstream|typescript|tsx|api route|endpoint|plugin|service)\b/i;

export function shouldRecommendLifeOpsContextBroker(taskText: string): boolean {
  const text = taskText.trim();
  if (!text) return false;
  if (EXPLICIT_BROKER_RE.test(text)) return true;
  const hasPersonalContext =
    PERSONAL_CONTEXT_RE.test(text) || LIFEOPS_CONTEXT_RE.test(text);
  if (!hasPersonalContext) return false;
  if (
    CODING_TASK_RE.test(text) &&
    !/\b(my|owner'?s|user'?s|personal)\b/i.test(text)
  ) {
    return false;
  }
  return true;
}

export function withLifeOpsContextBrokerRecommendation(
  taskText: string,
  recommendations: readonly RecommendedSkill[],
): RecommendedSkill[] {
  if (!shouldRecommendLifeOpsContextBroker(taskText)) {
    return recommendations.filter(
      (rec) => rec.slug !== LIFEOPS_CONTEXT_BROKER_SLUG,
    );
  }

  const withoutBroker = recommendations.filter(
    (rec) => rec.slug !== LIFEOPS_CONTEXT_BROKER_SLUG,
  );
  return [
    {
      slug: LIFEOPS_CONTEXT_BROKER_SLUG,
      name: LIFEOPS_CONTEXT_BROKER_MANIFEST_ENTRY.name,
      score: 1,
      reason: "task needs owner LifeOps context from the parent runtime",
    },
    ...withoutBroker,
  ];
}
