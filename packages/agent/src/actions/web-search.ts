import type {
  Action,
  ActionParameters,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  SearchCategoryFilter,
  SearchCategoryRegistration,
  State,
} from "@elizaos/core";
import {
  logger,
  SearchCategoryRegistryError,
  ServiceType,
} from "@elizaos/core";
import {
  registerVectorSearchCategory,
  searchVectorsAction,
} from "./database.js";
import {
  registerEntitySearchCategory,
  searchEntityAction,
} from "./entity-actions.js";
import { extractActionParamsViaLlm } from "./extract-params.js";
import {
  registerConversationSearchCategory,
  searchConversationsAction,
} from "./search-conversations.js";

type SearchFilters = Record<string, JsonValue | undefined>;

type UnifiedSearchParams = {
  category?: string;
  query?: string;
  filters?: SearchFilters;
  limit?: number;
  freshness?: string;
};

type SearchService = {
  search: (
    query: string,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

type PluginSearchResult = {
  name: string;
  description?: string;
  score?: number;
  tags?: string[];
  version?: string | null;
  npmPackage?: string;
  repository?: string;
  stars?: number;
  supports?: { v0?: boolean; v1?: boolean; v2?: boolean };
};

type PluginRegistrySearchService = {
  searchRegistry: (
    query: string,
    limit?: number,
  ) => Promise<PluginSearchResult[]>;
};

type KnowledgeSearchService = {
  getKnowledge: (
    message: Memory,
    scope?: Record<string, string | undefined>,
  ) => Promise<
    Array<{
      id?: string;
      content?: { text?: string };
      similarity?: number;
      metadata?: Record<string, unknown>;
      worldId?: string;
    }>
  >;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SEARCH_INTENT_PATTERN =
  /\b(search|find|look\s*up|query|discover|google|web\s*search)\b/i;

const CATEGORY_ALIASES: Record<string, string> = {
  chat: "conversations",
  chats: "conversations",
  contact: "entities",
  contacts: "entities",
  conversation: "conversations",
  conversations: "conversations",
  docs: "knowledge",
  documents: "knowledge",
  entity: "entities",
  entities: "entities",
  internet: "web",
  knowledge_base: "knowledge",
  message: "conversations",
  messages: "conversations",
  plugin: "plugins",
  plugins: "plugins",
  vector: "vectors",
  vectors: "vectors",
  web: "web",
};

const KNOWLEDGE_CATEGORY: SearchCategoryRegistration = {
  category: "knowledge",
  label: "Knowledge base",
  description: "Search stored knowledge documents and fragments.",
  contexts: ["knowledge"],
  filters: [
    {
      name: "scope",
      label: "Scope",
      description: "Optional scope: room, world, entity, or agent.",
      type: "enum",
      options: [
        { label: "Room", value: "room" },
        { label: "World", value: "world" },
        { label: "Entity", value: "entity" },
        { label: "Agent", value: "agent" },
      ],
    },
  ],
  resultSchemaSummary:
    "StoredKnowledgeItem[] with id, content.text, similarity, metadata, and worldId.",
  capabilities: ["semantic", "documents", "fragments"],
  source: "core:knowledge",
  serviceType: "knowledge",
};

const PLUGIN_CATEGORY: SearchCategoryRegistration = {
  category: "plugins",
  label: "Plugin registry",
  description: "Search the elizaOS plugin registry.",
  contexts: ["system", "knowledge"],
  filters: [
    {
      name: "tags",
      label: "Tags",
      description: "Require one or more plugin tags.",
      type: "string[]",
    },
    {
      name: "runtimeVersion",
      label: "Runtime version",
      description: "Filter by supported runtime version.",
      type: "enum",
      options: [
        { label: "v0", value: "v0" },
        { label: "v1", value: "v1" },
        { label: "v2", value: "v2" },
      ],
    },
  ],
  resultSchemaSummary:
    "PluginSearchResult[] with name, description, score, tags, version, npmPackage, repository, stars, supports.",
  capabilities: ["registry", "plugins", "install-discovery"],
  source: "core:plugin-manager",
  serviceType: "plugin_manager",
};

function normalizeCategory(category: string | undefined): string {
  const key = (category ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return CATEGORY_ALIASES[key] ?? key;
}

function hasCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

function registerCategoryIfMissing(
  runtime: IAgentRuntime,
  registration: SearchCategoryRegistration,
): void {
  if (!hasCategory(runtime, registration.category)) {
    runtime.registerSearchCategory(registration);
  }
}

function ensureBuiltInSearchCategories(runtime: IAgentRuntime): void {
  registerCategoryIfMissing(runtime, KNOWLEDGE_CATEGORY);
  registerCategoryIfMissing(runtime, PLUGIN_CATEGORY);
  registerConversationSearchCategory(runtime);
  registerEntitySearchCategory(runtime);
  registerVectorSearchCategory(runtime);
}

function updateSearchDescription(runtime: IAgentRuntime): void {
  const categories = runtime
    .getSearchCategories()
    .map((category) => {
      const filters = category.filters?.length
        ? ` filters=${category.filters.map((filter) => filter.name).join("|")}`
        : "";
      return `${category.category}(${category.label}${filters})`;
    })
    .join("; ");
  const suffix = categories ? ` Categories: ${categories}.` : "";
  searchAction.description =
    "Search a registered backend by category. Use category/query plus optional filters, limit, and freshness." +
    suffix;
  searchAction.descriptionCompressed = `search registered backend by category query filters limit freshness${categories ? ` categories ${categories}` : ""}`;
}

function readRawParams(options?: HandlerOptions): Partial<UnifiedSearchParams> {
  const params = (options?.parameters ?? {}) as Partial<UnifiedSearchParams>;
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFilters(params: Partial<UnifiedSearchParams>): SearchFilters {
  return isRecord(params.filters)
    ? { ...(params.filters as SearchFilters) }
    : {};
}

function clampLimit(limit: unknown, fallback = DEFAULT_LIMIT): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function validateFilterValue(
  filter: SearchCategoryFilter,
  value: unknown,
): string | null {
  if (value === undefined || value === null) {
    return filter.required ? `Missing required filter "${filter.name}".` : null;
  }

  switch (filter.type) {
    case "number":
      return typeof value === "number" && !Number.isNaN(value)
        ? null
        : `Filter "${filter.name}" must be a number.`;
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `Filter "${filter.name}" must be a boolean.`;
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? null
        : `Filter "${filter.name}" must be an ISO date string.`;
    case "enum": {
      const allowed = new Set(filter.options?.map((option) => option.value));
      return allowed.size === 0 || allowed.has(value as JsonValue)
        ? null
        : `Filter "${filter.name}" must be one of: ${[...allowed].join(", ")}.`;
    }
    case "string[]":
      return Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")
        ? null
        : `Filter "${filter.name}" must be an array of strings.`;
    case "number[]":
      return Array.isArray(value) &&
        value.every(
          (entry) => typeof entry === "number" && !Number.isNaN(entry),
        )
        ? null
        : `Filter "${filter.name}" must be an array of numbers.`;
    default:
      return typeof value === "string"
        ? null
        : `Filter "${filter.name}" must be a string.`;
  }
}

function validateFilters(
  registration: SearchCategoryRegistration,
  filters: SearchFilters,
): string | null {
  const definitions = new Map(
    (registration.filters ?? []).map((filter) => [filter.name, filter]),
  );
  for (const key of Object.keys(filters)) {
    if (!definitions.has(key)) {
      return `Filter "${key}" is not supported for category "${registration.category}".`;
    }
  }
  for (const filter of definitions.values()) {
    const error = validateFilterValue(filter, filters[filter.name]);
    if (error) return error;
  }
  return null;
}

function resultWithActionName(
  result: ActionResult | undefined,
  category: string,
): ActionResult {
  const base = result ?? { success: true };
  const data = isRecord(base.data) ? base.data : {};
  const backendActionName =
    typeof data.actionName === "string" ? data.actionName : undefined;
  return {
    ...base,
    values: {
      ...(base.values ?? {}),
      category,
    },
    data: {
      ...data,
      actionName: "SEARCH",
      category,
      ...(backendActionName ? { backendActionName } : {}),
    },
  };
}

function freshnessToDays(freshness: string | undefined): number | undefined {
  switch ((freshness ?? "").trim().toLowerCase()) {
    case "latest":
    case "today":
    case "day":
    case "24h":
      return 1;
    case "recent":
    case "week":
    case "7d":
      return 7;
    case "month":
    case "30d":
      return 30;
    default:
      return undefined;
  }
}

function normalizeWebResults(response: Record<string, unknown>) {
  const rawResults = Array.isArray(response.results) ? response.results : [];
  return rawResults.map((entry) => {
    const result = isRecord(entry) ? entry : {};
    return {
      title: String(result.title ?? "Untitled"),
      url: String(result.url ?? ""),
      description: String(result.description ?? result.content ?? ""),
      source: typeof result.source === "string" ? result.source : undefined,
      publishedDate:
        typeof result.publishedDate === "string"
          ? result.publishedDate
          : undefined,
    };
  });
}

async function runWebSearch(
  runtime: IAgentRuntime,
  query: string,
  filters: SearchFilters,
  limit: number,
  freshness?: string,
): Promise<ActionResult> {
  const service = runtime.getService(ServiceType.WEB_SEARCH) as unknown as
    | SearchService
    | null
    | undefined;
  if (!service?.search) {
    return {
      success: false,
      text: 'Web search service is not available. Enable plugin-web-search to use category "web".',
      values: { error: "SERVICE_NOT_FOUND" },
      data: {
        actionName: "SEARCH",
        category: "web",
        suppressPostActionContinuation: true,
      },
    };
  }

  const options = {
    ...filters,
    limit,
    days: freshnessToDays(freshness),
  };
  const response = await service.search(query, options);
  const results = normalizeWebResults(response);
  const answer = typeof response.answer === "string" ? response.answer : "";

  const lines = results.slice(0, limit).map((result, index) => {
    const description = result.description ? `\n   ${result.description}` : "";
    return `${index + 1}. **${result.title}**\n   ${result.url}${description}`;
  });
  const text =
    results.length === 0
      ? `No web results found for "${query}".`
      : [
          answer ? `Search answer for "${query}":\n\n${answer}` : "",
          `Web search results for "${query}":`,
          "",
          ...lines,
        ]
          .filter(Boolean)
          .join("\n");

  return {
    success: true,
    text,
    values: { resultCount: results.length, category: "web" },
    data: {
      actionName: "SEARCH",
      category: "web",
      query,
      results,
      raw: response,
    },
  };
}

async function runKnowledgeSearch(
  runtime: IAgentRuntime,
  message: Memory,
  query: string,
  filters: SearchFilters,
  limit: number,
): Promise<ActionResult> {
  const service = runtime.getService("knowledge") as unknown as
    | KnowledgeSearchService
    | null
    | undefined;
  if (!service?.getKnowledge) {
    return {
      success: false,
      text: "Knowledge service is not available.",
      values: { error: "SERVICE_NOT_FOUND" },
      data: { actionName: "SEARCH", category: "knowledge", query },
    };
  }

  const searchMessage: Memory = {
    ...message,
    content: { ...message.content, text: query },
  };
  const scope =
    typeof filters.scope === "string" && filters.scope !== "agent"
      ? {
          [`${filters.scope}Id`]: String(
            filters.scope === "room"
              ? message.roomId
              : filters.scope === "world"
                ? message.worldId
                : message.entityId,
          ),
        }
      : undefined;
  const results = (await service.getKnowledge(searchMessage, scope)).slice(
    0,
    limit,
  );

  const lines = results.map((item, index) => {
    const score =
      typeof item.similarity === "number"
        ? ` (${item.similarity.toFixed(3)})`
        : "";
    return `${index + 1}. ${item.content?.text ?? ""}${score}`;
  });

  return {
    success: true,
    text:
      results.length === 0
        ? `No knowledge results found for "${query}".`
        : [`Knowledge results for "${query}":`, "", ...lines].join("\n"),
    values: { resultCount: results.length, category: "knowledge" },
    data: {
      actionName: "SEARCH",
      category: "knowledge",
      query,
      results,
    },
  };
}

function applyPluginFilters(
  results: PluginSearchResult[],
  filters: SearchFilters,
): PluginSearchResult[] {
  let filtered = results;
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    const wanted = new Set(
      filters.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.toLowerCase()),
    );
    filtered = filtered.filter((plugin) =>
      (plugin.tags ?? []).some((tag) => wanted.has(tag.toLowerCase())),
    );
  }
  if (typeof filters.runtimeVersion === "string") {
    const runtimeVersion = filters.runtimeVersion as "v0" | "v1" | "v2";
    filtered = filtered.filter((plugin) => plugin.supports?.[runtimeVersion]);
  }
  return filtered;
}

async function runPluginSearch(
  runtime: IAgentRuntime,
  query: string,
  filters: SearchFilters,
  limit: number,
): Promise<ActionResult> {
  const service = runtime.getService("plugin_manager") as unknown as
    | PluginRegistrySearchService
    | null
    | undefined;
  if (!service?.searchRegistry) {
    return {
      success: false,
      text: "Plugin manager service is not available.",
      values: { error: "SERVICE_NOT_FOUND" },
      data: { actionName: "SEARCH", category: "plugins", query },
    };
  }

  const results = applyPluginFilters(
    await service.searchRegistry(query, limit),
    filters,
  ).slice(0, limit);
  const lines = results.map((plugin, index) => {
    const score =
      typeof plugin.score === "number"
        ? ` (${Math.round(plugin.score * 100)}%)`
        : "";
    const tags = plugin.tags?.length
      ? `\n   Tags: ${plugin.tags.join(", ")}`
      : "";
    return `${index + 1}. **${plugin.name}**${score}\n   ${plugin.description ?? ""}${tags}`;
  });

  return {
    success: true,
    text:
      results.length === 0
        ? `No plugins found matching "${query}".`
        : [
            `Found ${results.length} plugin(s) matching "${query}":`,
            "",
            ...lines,
          ].join("\n"),
    values: { resultCount: results.length, category: "plugins" },
    data: {
      actionName: "SEARCH",
      category: "plugins",
      query,
      results,
    },
  };
}

function dispatchLegacyAction(
  action: Action,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  parameters: SearchFilters,
): Promise<ActionResult> {
  const actionParameters: ActionParameters = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      actionParameters[key] = value;
    }
  }

  return action
    .handler(
      runtime,
      message,
      state,
      { parameters: actionParameters },
      undefined,
      undefined,
    )
    .then((result) => result ?? { success: true });
}

async function runCategorySearch(
  category: string,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Required<Pick<UnifiedSearchParams, "query">> &
    UnifiedSearchParams & { filters: SearchFilters; limit: number },
): Promise<ActionResult> {
  const { query, filters, limit, freshness } = params;
  switch (category) {
    case "web":
      return runWebSearch(runtime, query, filters, limit, freshness);
    case "knowledge":
      return runKnowledgeSearch(runtime, message, query, filters, limit);
    case "plugins":
      return runPluginSearch(runtime, query, filters, limit);
    case "vectors":
      return resultWithActionName(
        await dispatchLegacyAction(
          searchVectorsAction,
          runtime,
          message,
          state,
          {
            query,
            limit,
            ...filters,
          },
        ),
        category,
      );
    case "conversations":
      return resultWithActionName(
        await dispatchLegacyAction(
          searchConversationsAction,
          runtime,
          message,
          state,
          {
            query,
            limit,
            ...filters,
          },
        ),
        category,
      );
    case "entities":
      return resultWithActionName(
        await dispatchLegacyAction(
          searchEntityAction,
          runtime,
          message,
          state,
          {
            query,
            limit,
            ...filters,
          },
        ),
        category,
      );
    default:
      return {
        success: false,
        text: `Search category "${category}" is registered but this SEARCH action does not have a dispatcher for it yet.`,
        values: { error: "UNSUPPORTED_CATEGORY", category },
        data: { actionName: "SEARCH", category },
      };
  }
}

export const searchAction: Action = {
  name: "SEARCH",
  similes: [
    "SEARCH_WEB",
    "WEB_SEARCH",
    "SEARCH_KNOWLEDGE",
    "SEARCH_PLUGINS",
    "SEARCH_VECTORS",
    "SEARCH_CONVERSATIONS",
    "SEARCH_ENTITY",
  ],
  description:
    "Search a registered backend by category. Use category/query plus optional filters, limit, and freshness.",
  descriptionCompressed:
    "search registered backend by category query filters limit freshness",
  contexts: ["general", "knowledge", "browser", "system", "social"],
  roleGate: { minRole: "USER" },
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    ensureBuiltInSearchCategories(runtime);
    updateSearchDescription(runtime);
    const text = message.content?.text ?? "";
    return (
      runtime.getSearchCategories().length > 0 &&
      (SEARCH_INTENT_PATTERN.test(text) || text.trim().length === 0)
    );
  },

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    ensureBuiltInSearchCategories(runtime);
    updateSearchDescription(runtime);

    const rawParams = readRawParams(options as HandlerOptions | undefined);
    const extracted =
      (await extractActionParamsViaLlm<UnifiedSearchParams>({
        runtime,
        message,
        state,
        actionName: "SEARCH",
        actionDescription: searchAction.description,
        paramSchema: searchAction.parameters ?? [],
        existingParams: rawParams,
        requiredFields: ["category", "query"],
      })) ?? rawParams;

    const category = normalizeCategory(extracted.category);
    const query =
      typeof extracted.query === "string" ? extracted.query.trim() : "";
    const filters = readFilters(extracted);
    const limit = clampLimit(extracted.limit);

    if (!category) {
      return {
        success: false,
        text: "SEARCH requires a category.",
        values: { error: "MISSING_CATEGORY" },
        data: { actionName: "SEARCH" },
      };
    }
    if (!query) {
      return {
        success: false,
        text: "SEARCH requires a non-empty query.",
        values: { error: "MISSING_QUERY", category },
        data: { actionName: "SEARCH", category },
      };
    }

    let registration: SearchCategoryRegistration;
    try {
      registration = runtime.getSearchCategory(category);
    } catch (error) {
      if (error instanceof SearchCategoryRegistryError) {
        return {
          success: false,
          text: error.message,
          values: { error: error.code, category: error.category },
          data: { actionName: "SEARCH", category: error.category },
        };
      }
      throw error;
    }

    const filterError = validateFilters(registration, filters);
    if (filterError) {
      return {
        success: false,
        text: filterError,
        values: {
          error: "INVALID_FILTER",
          category: registration.category,
        },
        data: {
          actionName: "SEARCH",
          category: registration.category,
          filters,
        },
      };
    }

    try {
      return await runCategorySearch(
        registration.category,
        runtime,
        message,
        state,
        {
          category: registration.category,
          query,
          filters,
          limit,
          freshness: extracted.freshness,
        },
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`[SEARCH] ${registration.category} search failed: ${errMsg}`);
      return {
        success: false,
        text: `Search failed for category "${registration.category}": ${errMsg}`,
        values: {
          error: "SEARCH_FAILED",
          category: registration.category,
        },
        data: {
          actionName: "SEARCH",
          category: registration.category,
          query,
        },
      };
    }
  },

  parameters: [
    {
      name: "category",
      description:
        'Search category to use, for example "web", "knowledge", "plugins", "vectors", "conversations", or "entities".',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description: "Search text.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "filters",
      description:
        "Category-specific filter object. Supported keys are listed in the category description.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "limit",
      description: "Maximum number of results to return.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "freshness",
      description:
        'Freshness hint for categories that support recency, for example "day", "week", "month", "latest", or "recent".',
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Search the web for recent Solana validator changes.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Web search results for "recent Solana validator changes":',
          action: "SEARCH",
        },
      },
    ],
  ],
};

export const webSearchAction = searchAction;
