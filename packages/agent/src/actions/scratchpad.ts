import type {
  Action,
  ActionExample,
  ActionParameters,
  ActionResult,
  HandlerOptions,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";
import type {
  ScratchpadCreateTopicRequest,
  ScratchpadDeleteTopicResponse,
  ScratchpadReplaceTopicRequest,
  ScratchpadSearchResponse,
  ScratchpadTopicDto,
  ScratchpadTopicResponse,
} from "@elizaos/shared/contracts";

const REQUEST_TIMEOUT_MS = 30_000;

class ScratchpadActionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ScratchpadActionHttpError";
  }
}

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

function getParameters(options: HandlerOptions | undefined): ActionParameters {
  return options?.parameters ?? {};
}

function readStringParam(
  params: ActionParameters,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function readBooleanParam(
  params: ActionParameters,
  key: string,
): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumberParam(
  params: ActionParameters,
  key: string,
): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string;
    };
    return body.error ?? body.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function requestScratchpadJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ScratchpadActionHttpError(
      response.status,
      await readErrorMessage(response),
    );
  }
  return (await response.json()) as T;
}

function missingParam(name: string): ActionResult {
  return {
    success: false,
    text: `${name} is required.`,
    values: { error: `MISSING_${name.toUpperCase()}` },
  };
}

function confirmationRequired(action: string): ActionResult {
  return {
    success: false,
    text: `Refusing to ${action}: pass confirm:true to acknowledge this destructive action.`,
    values: { error: "CONFIRMATION_REQUIRED" },
  };
}

function summarizeTopic(topic: ScratchpadTopicDto): string {
  return `"${topic.title}" (${topic.tokenCount} tokens, ${topic.fragmentCount} fragments)`;
}

function renderTopic(topic: ScratchpadTopicDto): string {
  return [
    `Scratchpad topic: ${topic.title}`,
    `ID: ${topic.id}`,
    `Tokens: ${topic.tokenCount}`,
    `Fragments: ${topic.fragmentCount}`,
    `Summary: ${topic.summary}`,
    "",
    topic.text,
  ].join("\n");
}

function failureResult(actionName: string, err: unknown): ActionResult {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    err instanceof ScratchpadActionHttpError ? err.status : undefined;
  logger.warn(
    { actionName, error: message, status },
    "[ScratchpadAction] request failed",
  );
  return {
    success: false,
    text: `Scratchpad action failed: ${message}`,
    values: { error: "SCRATCHPAD_REQUEST_FAILED", status },
  };
}

export const scratchpadAddAction: Action = {
  name: "SCRATCHPAD_ADD",
  contexts: ["agent_internal", "memory", "knowledge"],
  roleGate: { minRole: "OWNER" },
  similes: ["ADD_TO_SCRATCHPAD", "CREATE_SCRATCHPAD_TOPIC"],
  description:
    "Create a scratchpad topic with a title and text body. The server validates title, text, topic cap, and token limit.",
  descriptionCompressed:
    "create scratchpad topic w/ title text body server validate title, text, topic cap, token limit",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = getParameters(options as HandlerOptions | undefined);
    const title = readStringParam(params, "title");
    const text = readStringParam(params, "text");
    if (!title) return missingParam("title");
    if (!text) return missingParam("text");

    const request: ScratchpadCreateTopicRequest = { title, text };
    try {
      const response = await requestScratchpadJson<ScratchpadTopicResponse>(
        "/api/knowledge/scratchpad/topics",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      return {
        success: true,
        text: `Added scratchpad topic ${summarizeTopic(response.topic)}.`,
        values: {
          topicId: response.topic.id,
          tokenCount: response.topic.tokenCount,
        },
        data: { actionName: "SCRATCHPAD_ADD", topic: response.topic },
      };
    } catch (err) {
      return failureResult("SCRATCHPAD_ADD", err);
    }
  },
  parameters: [
    {
      name: "title",
      description: "Scratchpad topic title.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Scratchpad topic body text.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Add a scratchpad topic called launch plan." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Added scratchpad topic...",
          action: "SCRATCHPAD_ADD",
        },
      },
    ],
  ] as ActionExample[][],
};

export const scratchpadReadAction: Action = {
  name: "SCRATCHPAD_READ",
  contexts: ["agent_internal", "memory", "knowledge"],
  roleGate: { minRole: "OWNER" },
  similes: ["READ_SCRATCHPAD", "GET_SCRATCHPAD_TOPIC"],
  description:
    "Fetch one scratchpad topic by id from GET /api/knowledge/scratchpad/topics/:id and return full title, summary, token counts, and body text. Owner-only.",
  descriptionCompressed:
    "GET scratchpad topic by topicId return full text owner-only",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = getParameters(options as HandlerOptions | undefined);
    const topicId = readStringParam(params, "topicId");
    if (!topicId) return missingParam("topicId");

    try {
      const response = await requestScratchpadJson<ScratchpadTopicResponse>(
        `/api/knowledge/scratchpad/topics/${encodeURIComponent(topicId)}`,
      );
      return {
        success: true,
        text: renderTopic(response.topic),
        values: {
          topicId: response.topic.id,
          tokenCount: response.topic.tokenCount,
        },
        data: { actionName: "SCRATCHPAD_READ", topic: response.topic },
      };
    } catch (err) {
      return failureResult("SCRATCHPAD_READ", err);
    }
  },
  parameters: [
    {
      name: "topicId",
      description: "Scratchpad topic id.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me scratchpad topic abc-123-def." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Scratchpad topic body...",
          action: "SCRATCHPAD_READ",
        },
      },
    ],
  ] as ActionExample[][],
};

export const scratchpadSearchAction: Action = {
  name: "SCRATCHPAD_SEARCH",
  contexts: ["agent_internal", "memory", "knowledge"],
  roleGate: { minRole: "OWNER" },
  similes: ["SEARCH_SCRATCHPAD", "FIND_SCRATCHPAD_TOPICS"],
  description:
    "Search scratchpad topics using the knowledge-backed search route.",
  descriptionCompressed:
    "search scratchpad topic use knowledge-back search route",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = getParameters(options as HandlerOptions | undefined);
    const query = readStringParam(params, "query");
    if (!query) return missingParam("query");
    const limit = readNumberParam(params, "limit");

    const search = new URLSearchParams({ q: query });
    if (limit !== undefined) search.set("limit", String(limit));

    try {
      const response = await requestScratchpadJson<ScratchpadSearchResponse>(
        `/api/knowledge/scratchpad/search?${search.toString()}`,
      );
      const lines = response.results.map((result, index) => {
        const matches = result.matches
          .map((match) => match.text.trim())
          .filter(Boolean)
          .slice(0, 2);
        return [
          `${index + 1}. ${summarizeTopic(result.topic)}`,
          `ID: ${result.topic.id}`,
          `Summary: ${result.topic.summary}`,
          ...matches.map((match) => `Match: ${match}`),
        ].join("\n");
      });
      return {
        success: true,
        text: [
          `Found ${response.count} scratchpad topic(s) for "${response.query}".`,
          ...lines,
        ].join("\n\n"),
        values: { count: response.count, query: response.query },
        data: {
          actionName: "SCRATCHPAD_SEARCH",
          query: response.query,
          results: response.results,
        },
      };
    } catch (err) {
      return failureResult("SCRATCHPAD_SEARCH", err);
    }
  },
  parameters: [
    {
      name: "query",
      description: "Search query.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Optional result limit. Server maximum is 10.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [],
};

export const scratchpadReplaceAction: Action = {
  name: "SCRATCHPAD_REPLACE",
  contexts: ["agent_internal", "memory", "knowledge"],
  roleGate: { minRole: "OWNER" },
  similes: ["REPLACE_SCRATCHPAD", "UPDATE_SCRATCHPAD_TOPIC"],
  description:
    "Replace an existing scratchpad topic by id. Requires confirm:true because it overwrites the topic body.",
  descriptionCompressed:
    "replace exist scratchpad topic id require confirm: true bc overwrite topic body",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = getParameters(options as HandlerOptions | undefined);
    const topicId = readStringParam(params, "topicId");
    const title = readStringParam(params, "title");
    const text = readStringParam(params, "text");
    if (!topicId) return missingParam("topicId");
    if (!title) return missingParam("title");
    if (!text) return missingParam("text");
    if (readBooleanParam(params, "confirm") !== true) {
      return confirmationRequired("replace scratchpad topic");
    }

    const request: ScratchpadReplaceTopicRequest = { title, text };
    try {
      const response = await requestScratchpadJson<ScratchpadTopicResponse>(
        `/api/knowledge/scratchpad/topics/${encodeURIComponent(topicId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      return {
        success: true,
        text: `Replaced scratchpad topic ${summarizeTopic(response.topic)}.`,
        values: {
          topicId: response.topic.id,
          tokenCount: response.topic.tokenCount,
        },
        data: { actionName: "SCRATCHPAD_REPLACE", topic: response.topic },
      };
    } catch (err) {
      return failureResult("SCRATCHPAD_REPLACE", err);
    }
  },
  parameters: [
    {
      name: "topicId",
      description: "Scratchpad topic id.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Replacement title.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Replacement text body.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "confirm",
      description: "Must be true to overwrite the topic.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [],
};

export const scratchpadDeleteAction: Action = {
  name: "SCRATCHPAD_DELETE",
  contexts: ["agent_internal", "memory", "knowledge"],
  roleGate: { minRole: "OWNER" },
  similes: ["DELETE_SCRATCHPAD_TOPIC", "REMOVE_SCRATCHPAD_TOPIC"],
  description:
    "Delete a scratchpad topic by id. Requires confirm:true because it removes the topic and its fragments.",
  descriptionCompressed:
    "delete scratchpad topic id require confirm: true bc remove topic fragment",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = getParameters(options as HandlerOptions | undefined);
    const topicId = readStringParam(params, "topicId");
    if (!topicId) return missingParam("topicId");
    if (readBooleanParam(params, "confirm") !== true) {
      return confirmationRequired("delete scratchpad topic");
    }

    try {
      const response =
        await requestScratchpadJson<ScratchpadDeleteTopicResponse>(
          `/api/knowledge/scratchpad/topics/${encodeURIComponent(topicId)}`,
          { method: "DELETE" },
        );
      return {
        success: true,
        text: `Deleted scratchpad topic ${response.topicId} (${response.deletedFragments} fragments removed).`,
        values: {
          topicId: response.topicId,
          deletedFragments: response.deletedFragments,
        },
        data: { actionName: "SCRATCHPAD_DELETE", response },
      };
    } catch (err) {
      return failureResult("SCRATCHPAD_DELETE", err);
    }
  },
  parameters: [
    {
      name: "topicId",
      description: "Scratchpad topic id.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "confirm",
      description: "Must be true to delete the topic.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [],
};
