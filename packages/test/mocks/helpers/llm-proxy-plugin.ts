import {
  type GenerateTextParams,
  type GenerateTextResult,
  type IAgentRuntime,
  type JsonValue,
  ModelType,
  type ModelTypeName,
  type Plugin,
  type ToolCall,
  type ToolDefinition,
} from "@elizaos/core";

export interface LlmProxyCall {
  modelType: ModelTypeName;
  params: GenerateTextParams;
  latestUserText: string;
  toolNames: string[];
}

export type LlmProxyResponse =
  | string
  | GenerateTextResult
  | Record<string, JsonValue>;

export interface DeterministicLlmProxyOptions {
  embeddingDimensions?: number;
  priority?: number;
  resolve?: (call: LlmProxyCall) => LlmProxyResponse | null | undefined;
}

const HANDLE_RESPONSE_TOOL_NAME = "HANDLE_RESPONSE";
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const TEXT_MODEL_TYPES = [
  ModelType.TEXT_NANO,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_MEDIUM,
  ModelType.TEXT_LARGE,
  ModelType.TEXT_MEGA,
  ModelType.TEXT_REASONING_SMALL,
  ModelType.TEXT_REASONING_LARGE,
  ModelType.TEXT_COMPLETION,
  ModelType.RESPONSE_HANDLER,
  ModelType.ACTION_PLANNER,
] as const;

export function createDeterministicLlmProxyPlugin(
  options: DeterministicLlmProxyOptions = {},
): Plugin {
  const embeddingDimensions =
    options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

  async function handleText(
    _runtime: IAgentRuntime,
    params: GenerateTextParams,
    modelType: ModelTypeName,
  ): Promise<string> {
    const call = buildCall(modelType, params);
    const resolved = options.resolve?.(call);
    if (resolved !== null && resolved !== undefined) {
      return normalizeResolvedResponse(resolved);
    }

    if (modelType === ModelType.RESPONSE_HANDLER) {
      return normalizeResolvedResponse(createHandleResponse(call));
    }

    if (modelType === ModelType.ACTION_PLANNER) {
      return normalizeResolvedResponse(createPlannerResponse(call));
    }

    if (params.responseSchema) {
      return JSON.stringify(schemaFixture(params.responseSchema));
    }

    return `deterministic-test-response: ${call.latestUserText || modelType}`;
  }

  const models: NonNullable<Plugin["models"]> = {
    [ModelType.TEXT_EMBEDDING]: async () =>
      new Array<number>(embeddingDimensions).fill(0),
  };

  for (const modelType of TEXT_MODEL_TYPES) {
    models[modelType] = ((runtime: IAgentRuntime, params: GenerateTextParams) =>
      handleText(runtime, params, modelType)) as never;
  }

  return {
    name: "deterministic-llm-proxy",
    description:
      "High-priority deterministic LLM proxy for zero-cost end-to-end tests.",
    priority: options.priority ?? 1_000,
    models,
  };
}

function buildCall(
  modelType: ModelTypeName,
  params: GenerateTextParams,
): LlmProxyCall {
  return {
    modelType,
    params,
    latestUserText: latestUserText(params),
    toolNames: (params.tools ?? []).map((tool) => tool.name),
  };
}

function normalizeResolvedResponse(response: LlmProxyResponse): string {
  if (typeof response === "string") return response;
  if ("text" in response && typeof response.text === "string") {
    return JSON.stringify(response);
  }
  return JSON.stringify(response);
}

function createHandleResponse(call: LlmProxyCall): GenerateTextResult {
  const lowered = call.latestUserText.toLowerCase();
  const shouldStop = /\b(stop|cancel|never mind|nevermind)\b/.test(lowered);
  const candidateActionNames = selectCandidateActionNames(call);
  const planning = candidateActionNames.length > 0;
  const args: Record<string, JsonValue> = {
    shouldRespond: shouldStop ? "STOP" : "RESPOND",
    contexts: shouldStop || !planning ? ["simple"] : ["actions"],
    intents: intentTags(call.latestUserText),
    replyText: shouldStop
      ? ""
      : planning
        ? "On it."
        : simpleReply(call.latestUserText),
    candidateActionNames,
    facts: [],
    relationships: [],
    addressedTo: [],
    emotion: "none",
  };

  return {
    text: JSON.stringify(args),
    finishReason: "tool-calls",
    toolCalls: [toolCall(HANDLE_RESPONSE_TOOL_NAME, args)],
  };
}

function createPlannerResponse(call: LlmProxyCall): GenerateTextResult {
  const selected = selectPlannerTool(call);
  if (!selected) {
    return {
      text: "No matching deterministic test action was selected.",
      finishReason: "stop",
    };
  }

  return {
    text: "",
    finishReason: "tool-calls",
    toolCalls: [toolCall(selected.name, defaultToolArguments(selected, call))],
  };
}

function selectCandidateActionNames(call: LlmProxyCall): string[] {
  const selected = selectPlannerTool(call);
  return selected ? [selected.name] : [];
}

function selectPlannerTool(call: LlmProxyCall): ToolDefinition | null {
  const tools = (call.params.tools ?? []).filter(
    (tool) => tool.name !== HANDLE_RESPONSE_TOOL_NAME,
  );
  if (tools.length === 0) return null;
  const text = call.latestUserText.toLowerCase();
  const scored = tools
    .map((tool, index) => ({
      index,
      score: scoreToolForText(tool, text),
      tool,
    }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const best = scored[0];
  return best?.score ? best.tool : (tools[0] ?? null);
}

function defaultToolArguments(
  tool: ToolDefinition,
  call: LlmProxyCall,
): Record<string, JsonValue> {
  const schema =
    tool.parameters &&
    typeof tool.parameters === "object" &&
    !Array.isArray(tool.parameters)
      ? tool.parameters
      : undefined;
  const properties =
    schema && "properties" in schema && isObject(schema.properties)
      ? schema.properties
      : {};
  const args: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    args[key] = schemaFixture(value, {
      call,
      key,
      toolName: tool.name,
    });
  }
  return args;
}

function schemaFixture(
  schema: unknown,
  context?: {
    call: LlmProxyCall;
    key: string;
    toolName: string;
  },
): JsonValue {
  if (!isObject(schema)) return "test-value";
  if ("const" in schema) return toJsonValue(schema.const);
  if ("default" in schema) return toJsonValue(schema.default);
  if (
    schema.type === "object" &&
    isObject(schema.properties) &&
    Object.keys(schema.properties).length > 0
  ) {
    const out: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out[key] = schemaFixture(value, {
        call: context?.call ?? {
          latestUserText: "",
          modelType: ModelType.TEXT_SMALL,
          params: {},
          toolNames: [],
        },
        key,
        toolName: context?.toolName ?? "",
      });
    }
    return out;
  }
  const semantic = context ? semanticFixture(context) : undefined;
  if (semantic !== undefined) return semantic;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return toJsonValue(schema.enum[0]);
  }
  if (schema.type === "object") {
    return {};
  }
  if (schema.type === "array") return [];
  if (schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "null") return null;
  return "test-value";
}

function semanticFixture({
  call,
  key,
  toolName,
}: {
  call: LlmProxyCall;
  key: string;
  toolName: string;
}): JsonValue | undefined {
  const fixture = intentFixture(call.latestUserText);
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedTool = toolName.toLowerCase();

  if (
    normalizedTool.includes("interact") ||
    normalizedTool.includes("capability")
  ) {
    if (normalizedKey === "name") return fixture.params.name;
    if (normalizedKey === "selector") return fixture.params.selector;
    if (normalizedKey === "value") return fixture.params.value;
  }
  if (normalizedTool === "views" || normalizedTool.endsWith(" views")) {
    if (normalizedKey === "action" || normalizedKey === "mode") {
      return inferViewsAction(call.latestUserText);
    }
    if (normalizedKey === "view") return fixture.viewId;
  }
  if (normalizedKey === "manifest") {
    return {
      id: fixture.viewId,
      title: fixture.title,
      source: fixture.source,
      entrypoint: fixture.entrypoint,
      placement: fixture.placement,
      description: `Deterministic test view for ${fixture.title}`,
      permissions: [],
      requiredRemotes: [],
      eventSubscriptions: [],
      invokeTargets: [],
      metadata: { deterministic: true },
    };
  }
  if (
    normalizedKey === "id" &&
    (normalizedTool.includes("dynamic") || normalizedTool.includes("view"))
  ) {
    return fixture.viewId;
  }
  if (normalizedKey.includes("viewid")) return fixture.viewId;
  if (normalizedKey.includes("sessionid")) return "dynamic-view-session-1";
  if (normalizedKey === "slug") return fixture.viewId;
  if (
    normalizedKey.includes("title") ||
    normalizedKey.includes("label") ||
    normalizedKey === "name"
  ) {
    return fixture.title;
  }
  if (normalizedKey.includes("path") || normalizedKey.includes("route")) {
    return fixture.path;
  }
  if (normalizedKey.includes("bundleurl")) return fixture.bundleUrl;
  if (normalizedKey.includes("entrypoint")) return fixture.entrypoint;
  if (normalizedKey.includes("source")) return fixture.source;
  if (normalizedKey.includes("placement")) return fixture.placement;
  if (normalizedKey === "capability") return fixture.capability;
  if (normalizedKey === "event" || normalizedKey.includes("eventname")) {
    return "deterministic-test-event";
  }
  if (normalizedKey === "params" || normalizedKey.includes("parameters")) {
    return fixture.params;
  }
  if (normalizedKey.includes("payload")) {
    return {
      viewId: fixture.viewId,
      deterministic: true,
    };
  }
  if (normalizedKey.includes("metadata")) {
    return {
      deterministic: true,
      viewId: fixture.viewId,
    };
  }
  if (normalizedKey.includes("pinned") || normalizedKey.includes("pin")) {
    return fixture.pinned;
  }
  if (normalizedKey.includes("alwaysontop")) return fixture.alwaysOnTop;
  if (normalizedKey === "update" || normalizedKey.includes("overwrite")) {
    return fixture.update;
  }
  return undefined;
}

function inferViewsAction(text: string): string {
  const lowered = text.toLowerCase();
  if (/\b(delete|remove|uninstall|destroy|drop)\b/.test(lowered)) {
    return "delete";
  }
  if (/\b(create|build|make|new|scaffold|generate|spin up)\b/.test(lowered)) {
    return "create";
  }
  if (
    /\b(edit|update|modify|change|fix|improve|rewrite|rename)\b/.test(lowered)
  ) {
    return "edit";
  }
  if (
    /\b(open in.*window|new window|separate window|pop.?out|detach)\b/.test(
      lowered,
    )
  ) {
    return "window";
  }
  if (
    /\b(pin|pin as tab|add.*tab|pin.*desktop|keep.*tab|dock)\b/.test(lowered)
  ) {
    return "pin";
  }
  if (
    /\b(click|tap|press|focus|fill|interact|invoke|call|use capability)\b/.test(
      lowered,
    )
  ) {
    return "interact";
  }
  if (
    /\b(tell|notify|signal|broadcast|send.*event|emit|trigger|ping)\b/.test(
      lowered,
    )
  ) {
    return "broadcast";
  }
  if (
    /\b(view manager|views manager|manage views|open manager|show manager|apps page)\b/.test(
      lowered,
    )
  ) {
    return "manager";
  }
  if (/\b(search|find|look for|filter)\b.*\bview/i.test(text)) {
    return "search";
  }
  if (/\b(current|active|selected)\b.{0,30}\bview\b/.test(lowered)) {
    return "current";
  }
  if (
    /\b(list|show all|what views|all views|available views|which views)\b/.test(
      lowered,
    )
  ) {
    return "list";
  }
  return "show";
}

function intentFixture(text: string): {
  alwaysOnTop: boolean;
  bundleUrl: string;
  capability: string;
  entrypoint: string;
  params: Record<string, JsonValue>;
  path: string;
  pinned: boolean;
  placement: string;
  source: string;
  title: string;
  update: boolean;
  viewId: string;
} {
  const lowered = text.toLowerCase();
  const viewId = inferViewId(lowered);
  const title = inferTitle(text, viewId);
  const remote = /\b(remote|bundle|module|plugin)\b/.test(lowered);
  const pinned = /\b(pin|tab|desktop)\b/.test(lowered);
  const capability = inferCapability(lowered);
  return {
    alwaysOnTop: /\b(always on top|floating|keep.*top)\b/.test(lowered),
    bundleUrl: `/api/views/${viewId}/bundle.js`,
    capability,
    entrypoint: remote ? `/api/views/${viewId}/bundle.js` : `${viewId}.html`,
    params: inferCapabilityParams(text, capability),
    path: `/apps/${viewId}`,
    pinned,
    placement: pinned ? "desktop-tab" : "floating",
    source: remote ? "remote-plugin" : "local",
    title,
    update: /\b(update|edit|rename|change|modify)\b/.test(lowered),
    viewId,
  };
}

function inferCapability(loweredText: string): string {
  if (/\b(fill|type|enter|input)\b/.test(loweredText)) return "fill-input";
  if (/\b(click|tap|press|submit|save)\b/.test(loweredText)) {
    return "click-element";
  }
  if (/\bfocus\b/.test(loweredText)) return "focus-element";
  if (/\bstate|json|data\b/.test(loweredText)) return "get-state";
  if (/\brefresh|reload\b/.test(loweredText)) return "refresh";
  return "get-text";
}

function inferCapabilityParams(
  text: string,
  capability: string,
): Record<string, JsonValue> {
  const lowered = text.toLowerCase();
  const selector =
    lowered.includes("save") || lowered.includes("submit")
      ? ".submit-view"
      : lowered.includes("create")
        ? ".primary-action"
        : lowered.includes("button")
          ? "button"
          : undefined;
  const name =
    lowered.includes("title") || lowered.includes("input")
      ? "view-title"
      : undefined;
  if (capability === "fill-input") {
    return {
      name: name ?? "view-title",
      value: inferInputValue(text),
    };
  }
  if (capability === "click-element") {
    return selector ? { selector } : { name: name ?? "view-title" };
  }
  if (capability === "focus-element") {
    return name ? { name } : { selector: selector ?? "button" };
  }
  return {};
}

function inferInputValue(text: string): string {
  const explicit = text.match(
    /\b(?:to|with|as)\s+["'`]?(?<value>[a-z0-9][a-z0-9\s-]*?)(?:["'`])?(?=\s+(?:and|then|before|after)\b|[.!?]?$)/i,
  )?.groups?.value;
  return explicit ? titleCase(explicit) : "Remote Ledger Updated";
}

function inferViewId(loweredText: string): string {
  if (/\bledger|finance|remote\b/.test(loweredText)) return "remote-ledger";
  if (/\bnote|notes|local\b/.test(loweredText)) return "local-notes";
  if (/\btrace|diagnostic|run\b/.test(loweredText)) return "agent-run-trace";
  if (/\bmanager|views?\b/.test(loweredText)) return "view-manager";
  const quoted = loweredText.match(/["'`](?<name>[a-z0-9][a-z0-9\s-]+)["'`]/)
    ?.groups?.name;
  if (quoted) return slugify(quoted);
  return "deterministic-view";
}

function inferTitle(text: string, viewId: string): string {
  const explicit = text.match(
    /\b(?:title|rename|label|name)\b.*?\b(?:to|as)\s+["'`]?(?<title>[a-z0-9][a-z0-9\s-]*?)(?:["'`])?(?=\s+(?:and|then|with|while)\b|[.!?]?$)/i,
  )?.groups?.title;
  if (explicit) return titleCase(explicit);
  return titleFromViewId(viewId);
}

function titleFromViewId(viewId: string): string {
  return titleCase(viewId);
}

function titleCase(text: string): string {
  return text
    .split("-")
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "deterministic-view";
}

function latestUserText(params: GenerateTextParams): string {
  const messages = params.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return contentToText(message.content);
  }
  return params.prompt ?? "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        isObject(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join(" ")
    .trim();
}

function intentTags(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.length > 0 ? [words.join("-")] : [];
}

function scoreToolForText(tool: ToolDefinition, text: string): number {
  const normalizedToolName = tool.name.toLowerCase().replaceAll("_", " ");
  let score = text.includes(normalizedToolName) ? 100 : 0;
  const textTokens = tokenize(text);
  const toolTokens = new Set([
    ...tokenize(tool.name),
    ...tokenize(typeof tool.description === "string" ? tool.description : ""),
  ]);
  for (const token of textTokens) {
    if (toolTokens.has(token)) score += 4;
  }
  for (const hint of actionHints(text)) {
    if (toolTokens.has(hint)) score += 20;
  }
  return score;
}

function actionHints(text: string): string[] {
  const hints = new Set<string>();
  if (/\b(create|new|add|register|make)\b/.test(text)) {
    hints.add("create");
    hints.add("register");
    hints.add("open");
  }
  if (/\b(open|show|switch|navigate|go|view)\b/.test(text)) {
    hints.add("open");
    hints.add("show");
    hints.add("switch");
    hints.add("navigate");
  }
  if (/\b(update|edit|rename|change|modify)\b/.test(text)) {
    hints.add("update");
    hints.add("edit");
    hints.add("register");
  }
  if (/\b(delete|remove|close|unregister)\b/.test(text)) {
    hints.add("delete");
    hints.add("remove");
    hints.add("close");
    hints.add("unregister");
  }
  if (/\b(pin|tab)\b/.test(text)) {
    hints.add("pin");
    hints.add("tab");
  }
  if (/\b(remote|bundle|module|plugin)\b/.test(text)) {
    hints.add("remote");
    hints.add("plugin");
    hints.add("bundle");
  }
  if (/\b(local|builtin|built-in)\b/.test(text)) {
    hints.add("local");
    hints.add("builtin");
  }
  return [...hints];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function simpleReply(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `Deterministic test reply for: ${trimmed}` : "Ready.";
}

function toolCall(name: string, args: Record<string, JsonValue>): ToolCall {
  return {
    id: `deterministic-${name.toLowerCase().replaceAll("_", "-")}`,
    name,
    arguments: args,
    type: "function",
    status: "completed",
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
