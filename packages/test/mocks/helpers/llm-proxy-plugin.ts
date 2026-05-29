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

export type LlmProxyTextMatcher =
  | string
  | RegExp
  | ((value: string, call: LlmProxyCall) => boolean);

export type LlmProxySchemaMatcher =
  | JsonValue
  | Record<string, unknown>
  | ((schema: unknown, call: LlmProxyCall) => boolean);

export interface LlmProxyFixtureMatch {
  modelType?: ModelTypeName | ModelTypeName[];
  /**
   * Matches the normalized latest user text when present, otherwise the raw
   * prompt. Use this for "which test/input is being run" fixtures.
   */
  input?: LlmProxyTextMatcher;
  prompt?: LlmProxyTextMatcher;
  toolName?: LlmProxyTextMatcher;
  toolNames?: string[];
  responseSchema?: LlmProxySchemaMatcher;
  toolSchema?: LlmProxySchemaMatcher;
}

export interface LlmProxyFixture {
  name: string;
  match?: LlmProxyFixtureMatch | ((call: LlmProxyCall) => boolean);
  response?: LlmProxyResponse | ((call: LlmProxyCall) => LlmProxyResponse);
  resolve?: (call: LlmProxyCall) => LlmProxyResponse | null | undefined;
  required?: boolean;
  /**
   * Defaults to "at least once". Set a number for exact consumption or "any"
   * for optional reusable fixtures.
   */
  times?: number | "any" | { min?: number; max?: number };
  validateResponse?: boolean;
}

export interface LlmProxyFixtureDiagnostics {
  calls: LlmProxyCallDiagnostic[];
  fixtures: LlmProxyFixtureDiagnostic[];
  unexpectedCalls: LlmProxyCallDiagnostic[];
}

export interface LlmProxyCallDiagnostic {
  modelType: ModelTypeName;
  latestUserText: string;
  prompt: string;
  toolNames: string[];
  responseSchemaFingerprint?: string;
  tools: Array<{
    name: string;
    description: string;
    schemaFingerprint?: string;
  }>;
}

export interface LlmProxyFixtureDiagnostic {
  name: string;
  consumed: number;
  min: number;
  max: number | "unbounded";
  required: boolean;
}

export interface DeterministicLlmFixtureRegistry {
  register(...fixtures: LlmProxyFixture[]): void;
  assertConsumed(): void;
  diagnostics(): LlmProxyFixtureDiagnostics;
  resetConsumption(): void;
}

export interface DeterministicLlmProxyPlugin extends Plugin {
  llmFixtures: DeterministicLlmFixtureRegistry;
  assertFixturesConsumed(): void;
  getFixtureDiagnostics(): LlmProxyFixtureDiagnostics;
}

export interface DeterministicLlmProxyOptions {
  embeddingDimensions?: number;
  /**
   * Fail ACTION_PLANNER calls when the prompt cannot be matched to a provided
   * tool. This keeps PR E2E tests from passing after the proxy silently picked
   * the first available tool.
   */
  failOnUnhandledAction?: boolean;
  /**
   * Strict fixture mode fails every unregistered LLM call before the generic
   * heuristic fallback can run. This is intended for CI E2E where model output
   * must be exact and secret-free.
   */
  strict?: boolean;
  fixtures?: LlmProxyFixture[];
  fixtureRegistry?: DeterministicLlmFixtureRegistry;
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
): DeterministicLlmProxyPlugin {
  const embeddingDimensions =
    options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const fixtureRegistry =
    options.fixtureRegistry ?? createDeterministicLlmFixtureRegistry();
  if (options.fixtures?.length) {
    fixtureRegistry.register(...options.fixtures);
  }

  async function handleText(
    _runtime: IAgentRuntime,
    params: GenerateTextParams,
    modelType: ModelTypeName,
  ): Promise<string> {
    const call = buildCall(modelType, params);
    const fixtureResolved = resolveFixtureCall(fixtureRegistry, call);
    if (fixtureResolved !== undefined) {
      return fixtureResolved;
    }

    const resolved = options.resolve?.(call);
    if (resolved !== null && resolved !== undefined) {
      return options.strict
        ? normalizeAndValidateFixtureResponse(resolved, call, "resolve")
        : normalizeResolvedResponse(resolved);
    }

    if (options.strict) {
      throw createUnhandledFixtureCallError(fixtureRegistry, call);
    }

    if (modelType === ModelType.RESPONSE_HANDLER) {
      return normalizeResolvedResponse(
        createHandleResponse(call, options.failOnUnhandledAction ?? true),
      );
    }

    if (modelType === ModelType.ACTION_PLANNER) {
      return normalizeResolvedResponse(
        createPlannerResponse(call, options.failOnUnhandledAction ?? true),
      );
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
    llmFixtures: fixtureRegistry,
    assertFixturesConsumed: () => fixtureRegistry.assertConsumed(),
    getFixtureDiagnostics: () => fixtureRegistry.diagnostics(),
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

export function createDeterministicLlmFixtureRegistry(
  fixtures: LlmProxyFixture[] = [],
): DeterministicLlmFixtureRegistry {
  const entries: RegisteredLlmProxyFixture[] = fixtures.map(registerFixture);
  const calls: LlmProxyCallDiagnostic[] = [];
  const unexpectedCalls: LlmProxyCallDiagnostic[] = [];

  const registry: DeterministicLlmFixtureRegistry = {
    register(...nextFixtures: LlmProxyFixture[]): void {
      entries.push(...nextFixtures.map(registerFixture));
    },
    assertConsumed(): void {
      const unused = entries.filter((entry) => entry.consumed < entry.min);
      if (unused.length === 0) return;
      throw new Error(
        [
          "deterministic LLM proxy fixture registry has unused fixtures",
          "Expected: all required deterministic LLM fixtures are consumed by the test.",
          `Actual: ${JSON.stringify({
            unused: unused.map(fixtureDiagnostic),
            calls,
          })}`,
        ].join("\n"),
      );
    },
    diagnostics(): LlmProxyFixtureDiagnostics {
      return {
        calls: [...calls],
        fixtures: entries.map(fixtureDiagnostic),
        unexpectedCalls: [...unexpectedCalls],
      };
    },
    resetConsumption(): void {
      calls.length = 0;
      unexpectedCalls.length = 0;
      for (const entry of entries) {
        entry.consumed = 0;
      }
    },
  };
  registryResolve.set(registry, resolve);
  registryRecordUnexpected.set(registry, (call) => {
    unexpectedCalls.push(callDiagnostic(call));
  });
  return registry;

  function registerFixture(
    fixture: LlmProxyFixture,
  ): RegisteredLlmProxyFixture {
    if (!fixture.name.trim()) {
      throw new Error("deterministic LLM fixture name is required");
    }
    if (fixture.response === undefined && fixture.resolve === undefined) {
      throw new Error(
        `deterministic LLM fixture "${fixture.name}" must define response or resolve`,
      );
    }
    const { min, max } = fixtureConsumptionBounds(fixture);
    return { ...fixture, min, max, consumed: 0 };
  }

  function resolve(call: LlmProxyCall): string | undefined {
    calls.push(callDiagnostic(call));

    const matched: Array<{
      entry: RegisteredLlmProxyFixture;
      response: LlmProxyResponse;
    }> = [];
    const exhausted: RegisteredLlmProxyFixture[] = [];

    for (const entry of entries) {
      if (!matchesFixture(entry, call)) continue;
      const response = resolveFixtureResponse(entry, call);
      if (response === undefined || response === null) continue;
      if (entry.consumed >= entry.max) {
        exhausted.push(entry);
        continue;
      }
      matched.push({ entry, response });
    }

    if (matched.length > 1) {
      unexpectedCalls.push(callDiagnostic(call));
      throw new Error(
        [
          "deterministic LLM proxy fixture registry matched multiple fixtures",
          "Expected: each strict deterministic LLM call must match exactly one fixture.",
          `Actual: ${JSON.stringify({
            call: callDiagnostic(call),
            matchingFixtures: matched.map(({ entry }) => entry.name),
            fixtures: entries.map(fixtureDiagnostic),
          })}`,
        ].join("\n"),
      );
    }

    if (matched.length === 0 && exhausted.length > 0) {
      unexpectedCalls.push(callDiagnostic(call));
      throw new Error(
        [
          "deterministic LLM proxy fixture registry exhausted a matching fixture",
          "Expected: fixture consumption bounds must cover every matching LLM call.",
          `Actual: ${JSON.stringify({
            call: callDiagnostic(call),
            exhaustedFixtures: exhausted.map(fixtureDiagnostic),
          })}`,
        ].join("\n"),
      );
    }

    const selected = matched[0];
    if (!selected) return undefined;

    selected.entry.consumed += 1;
    return selected.entry.validateResponse === false
      ? normalizeResolvedResponse(selected.response)
      : normalizeAndValidateFixtureResponse(
          selected.response,
          call,
          selected.entry.name,
        );
  }
}

type RegistryResolve = (call: LlmProxyCall) => string | undefined;

const registryResolve = new WeakMap<
  DeterministicLlmFixtureRegistry,
  RegistryResolve
>();
const registryRecordUnexpected = new WeakMap<
  DeterministicLlmFixtureRegistry,
  (call: LlmProxyCall) => void
>();

interface RegisteredLlmProxyFixture extends LlmProxyFixture {
  consumed: number;
  min: number;
  max: number;
}

function resolveFixtureCall(
  registry: DeterministicLlmFixtureRegistry,
  call: LlmProxyCall,
): string | undefined {
  return registryResolve.get(registry)?.(call);
}

function createUnhandledFixtureCallError(
  registry: DeterministicLlmFixtureRegistry,
  call: LlmProxyCall,
): Error {
  registryRecordUnexpected.get(registry)?.(call);
  const diagnostics = registry.diagnostics();
  return new Error(
    [
      "deterministic LLM proxy fixture registry has no fixture for this call",
      "Expected: strict E2E tests must register a fixture or resolver for every LLM call, keyed by modelType/input/tool/schema.",
      `Actual: ${JSON.stringify({
        call: callDiagnostic(call),
        fixtures: diagnostics.fixtures,
      })}`,
    ].join("\n"),
  );
}

function fixtureConsumptionBounds(fixture: LlmProxyFixture): {
  min: number;
  max: number;
} {
  if (fixture.times === "any") return { min: 0, max: Number.POSITIVE_INFINITY };
  if (typeof fixture.times === "number") {
    return { min: fixture.times, max: fixture.times };
  }
  if (fixture.times && typeof fixture.times === "object") {
    const min = fixture.times.min ?? (fixture.required === false ? 0 : 1);
    const max = fixture.times.max ?? Number.POSITIVE_INFINITY;
    return { min, max };
  }
  return {
    min: fixture.required === false ? 0 : 1,
    max: Number.POSITIVE_INFINITY,
  };
}

function fixtureDiagnostic(
  fixture: RegisteredLlmProxyFixture,
): LlmProxyFixtureDiagnostic {
  return {
    name: fixture.name,
    consumed: fixture.consumed,
    min: fixture.min,
    max: Number.isFinite(fixture.max) ? fixture.max : "unbounded",
    required: fixture.min > 0,
  };
}

function matchesFixture(
  fixture: RegisteredLlmProxyFixture,
  call: LlmProxyCall,
): boolean {
  if (!fixture.match) return true;
  if (typeof fixture.match === "function") return fixture.match(call);

  const match = fixture.match;
  if (match.modelType) {
    const expected = Array.isArray(match.modelType)
      ? match.modelType
      : [match.modelType];
    if (!expected.includes(call.modelType)) return false;
  }
  if (
    match.input &&
    !matchesText(
      match.input,
      call.latestUserText || call.params.prompt || "",
      call,
    )
  ) {
    return false;
  }
  if (
    match.prompt &&
    !matchesText(match.prompt, call.params.prompt ?? "", call)
  ) {
    return false;
  }
  const toolNameMatcher = match.toolName;
  if (
    toolNameMatcher &&
    !call.toolNames.some((toolName) =>
      matchesText(toolNameMatcher, toolName, call),
    )
  ) {
    return false;
  }
  if (
    match.toolNames &&
    !match.toolNames.every((toolName) => call.toolNames.includes(toolName))
  ) {
    return false;
  }
  if (
    match.responseSchema !== undefined &&
    !matchesSchema(match.responseSchema, call.params.responseSchema, call)
  ) {
    return false;
  }
  if (match.toolSchema !== undefined) {
    const tools = (call.params.tools ?? []).filter((tool) =>
      match.toolName ? matchesText(match.toolName, tool.name, call) : true,
    );
    if (
      !tools.some((tool) =>
        matchesSchema(match.toolSchema, tool.parameters, call),
      )
    ) {
      return false;
    }
  }
  return true;
}

function matchesText(
  matcher: LlmProxyTextMatcher,
  value: string,
  call: LlmProxyCall,
): boolean {
  if (typeof matcher === "string") return matcher === value;
  if (matcher instanceof RegExp) return matcher.test(value);
  return matcher(value, call);
}

function matchesSchema(
  matcher: LlmProxySchemaMatcher,
  schema: unknown,
  call: LlmProxyCall,
): boolean {
  if (typeof matcher === "function") return matcher(schema, call);
  if (typeof matcher === "string") {
    return matcher === schemaFingerprint(schema);
  }
  return schemaFingerprint(matcher) === schemaFingerprint(schema);
}

function resolveFixtureResponse(
  fixture: RegisteredLlmProxyFixture,
  call: LlmProxyCall,
): LlmProxyResponse | null | undefined {
  if (fixture.resolve) return fixture.resolve(call);
  return typeof fixture.response === "function"
    ? fixture.response(call)
    : fixture.response;
}

function normalizeAndValidateFixtureResponse(
  response: LlmProxyResponse,
  call: LlmProxyCall,
  fixtureName: string,
): string {
  const normalized = normalizeResolvedResponse(response);
  validateFixtureResponse(normalized, call, fixtureName);
  return normalized;
}

function validateFixtureResponse(
  normalized: string,
  call: LlmProxyCall,
  fixtureName: string,
): void {
  const expectsStructuredJson =
    call.modelType === ModelType.ACTION_PLANNER ||
    call.modelType === ModelType.RESPONSE_HANDLER ||
    call.params.responseSchema !== undefined ||
    responseFormatExpectsJson(call.params.responseFormat);
  if (!expectsStructuredJson) return;

  const parsed = parseJsonWithFixtureName(normalized, fixtureName);
  const result = isGenerateTextResultLike(parsed) ? parsed : null;

  if (result) {
    if ("text" in result && typeof result.text !== "string") {
      throw invalidFixtureResponseError(fixtureName, [
        "GenerateTextResult.text must be a string when present",
      ]);
    }
    if ("toolCalls" in result) {
      validateToolCalls(result.toolCalls, call, fixtureName);
    }
    if (
      call.params.responseSchema &&
      typeof result.text === "string" &&
      result.text.trim()
    ) {
      const textJson = parseJsonWithFixtureName(result.text, fixtureName);
      validateSchemaOrThrow(textJson, call.params.responseSchema, fixtureName);
    }
    return;
  }

  if (call.params.responseSchema) {
    validateSchemaOrThrow(parsed, call.params.responseSchema, fixtureName);
  }
}

function validateToolCalls(
  toolCalls: unknown,
  call: LlmProxyCall,
  fixtureName: string,
): void {
  if (!Array.isArray(toolCalls)) {
    throw invalidFixtureResponseError(fixtureName, [
      "GenerateTextResult.toolCalls must be an array",
    ]);
  }
  const toolsByName = new Map(
    (call.params.tools ?? []).map((tool) => [tool.name, tool]),
  );
  const errors: string[] = [];
  for (const [index, toolCallValue] of toolCalls.entries()) {
    if (!isObject(toolCallValue)) {
      errors.push(`toolCalls[${index}] must be an object`);
      continue;
    }
    const name = toolCallValue.name;
    if (typeof name !== "string") {
      errors.push(`toolCalls[${index}].name must be a string`);
      continue;
    }
    const tool = toolsByName.get(name);
    if (!tool) {
      errors.push(
        `toolCalls[${index}].name "${name}" is not in available tools: ${call.toolNames.join(", ")}`,
      );
      continue;
    }
    const args = parseToolCallArguments(toolCallValue.arguments, fixtureName);
    if (tool.parameters) {
      errors.push(
        ...validateJsonAgainstSchema(
          args,
          tool.parameters,
          `toolCalls[${index}].arguments`,
        ),
      );
    }
  }
  if (errors.length > 0) {
    throw invalidFixtureResponseError(fixtureName, errors);
  }
}

function validateSchemaOrThrow(
  value: unknown,
  schema: unknown,
  fixtureName: string,
): void {
  const errors = validateJsonAgainstSchema(value, schema, "$");
  if (errors.length > 0) {
    throw invalidFixtureResponseError(fixtureName, errors);
  }
}

function validateJsonAgainstSchema(
  value: unknown,
  schema: unknown,
  path: string,
): string[] {
  if (!isObject(schema)) return [];
  const errors: string[] = [];
  if ("const" in schema && !deepEqualJson(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some((item) => deepEqualJson(value, item))) {
      errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    }
  }

  const typeEntries = Array.isArray(schema.type) ? schema.type : [schema.type];
  const types = typeEntries.filter(
    (type): type is string => typeof type === "string",
  );
  if (
    types.length > 0 &&
    !types.some((type) => valueMatchesJsonType(value, type))
  ) {
    errors.push(`${path} must be ${types.join(" or ")}`);
    return errors;
  }

  const shouldValidateObject =
    schema.type === "object" ||
    isObject(schema.properties) ||
    Array.isArray(schema.required);
  if (shouldValidateObject && !isObject(value)) {
    errors.push(`${path} must be object`);
    return errors;
  }
  if (shouldValidateObject && isObject(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    if (isObject(schema.properties)) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in value) {
          errors.push(
            ...validateJsonAgainstSchema(
              value[key],
              propertySchema,
              `${path}.${key}`,
            ),
          );
        }
      }
    }
    if (schema.additionalProperties === false && isObject(schema.properties)) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }

  const shouldValidateArray = schema.type === "array" || "items" in schema;
  if (shouldValidateArray && !Array.isArray(value)) {
    errors.push(`${path} must be array`);
    return errors;
  }
  if (shouldValidateArray && Array.isArray(value) && "items" in schema) {
    for (const [index, item] of value.entries()) {
      errors.push(
        ...validateJsonAgainstSchema(item, schema.items, `${path}[${index}]`),
      );
    }
  }

  return errors;
}

function valueMatchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isObject(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function parseToolCallArguments(args: unknown, fixtureName: string): unknown {
  if (typeof args === "string")
    return parseJsonWithFixtureName(args, fixtureName);
  return args;
}

function parseJsonWithFixtureName(value: string, fixtureName: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw invalidFixtureResponseError(fixtureName, [
      `response must be parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function invalidFixtureResponseError(
  fixtureName: string,
  errors: string[],
): Error {
  return new Error(
    [
      `deterministic LLM fixture "${fixtureName}" returned invalid output`,
      "Expected: fixture output must be parseable JSON and match the requested response/tool schema when one is available.",
      `Actual: ${JSON.stringify({ errors })}`,
    ].join("\n"),
  );
}

function responseFormatExpectsJson(
  responseFormat: GenerateTextParams["responseFormat"],
): boolean {
  if (typeof responseFormat === "string")
    return responseFormat.includes("json");
  return responseFormat?.type === "json_object";
}

function isGenerateTextResultLike(
  value: unknown,
): value is Record<string, unknown> {
  return isObject(value) && ("toolCalls" in value || "finishReason" in value);
}

function callDiagnostic(call: LlmProxyCall): LlmProxyCallDiagnostic {
  return {
    modelType: call.modelType,
    latestUserText: call.latestUserText,
    prompt: truncateDiagnostic(call.params.prompt ?? ""),
    toolNames: call.toolNames,
    responseSchemaFingerprint: call.params.responseSchema
      ? schemaFingerprint(call.params.responseSchema)
      : undefined,
    tools: (call.params.tools ?? []).map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      schemaFingerprint: tool.parameters
        ? schemaFingerprint(tool.parameters)
        : undefined,
    })),
  };
}

function truncateDiagnostic(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function schemaFingerprint(schema: unknown): string {
  return stableStringify(schema);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function normalizeResolvedResponse(response: LlmProxyResponse): string {
  if (typeof response === "string") return response;
  if ("text" in response && typeof response.text === "string") {
    return JSON.stringify(response);
  }
  return JSON.stringify(response);
}

function createHandleResponse(
  call: LlmProxyCall,
  failOnUnhandledAction: boolean,
): GenerateTextResult {
  const lowered = call.latestUserText.toLowerCase();
  const shouldStop = /\b(stop|cancel|never mind|nevermind)\b/.test(lowered);
  const candidateActionNames = selectCandidateActionNames(
    call,
    failOnUnhandledAction,
  );
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

function createPlannerResponse(
  call: LlmProxyCall,
  failOnUnhandledAction: boolean,
): GenerateTextResult {
  const selected = selectPlannerTool(call, failOnUnhandledAction);
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

function selectCandidateActionNames(
  call: LlmProxyCall,
  failOnUnhandledAction: boolean,
): string[] {
  const selected = selectPlannerTool(call, failOnUnhandledAction);
  return selected ? [selected.name] : [];
}

function selectPlannerTool(
  call: LlmProxyCall,
  failOnUnhandledAction: boolean,
): ToolDefinition | null {
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
  if (!best?.score) {
    if (failOnUnhandledAction) {
      throw new Error(
        unhandledPlannerMessage(call, scored, "no matching tool"),
      );
    }
    return tools[0] ?? null;
  }
  const tied = scored.filter((entry) => entry.score === best.score);
  if (failOnUnhandledAction && tied.length > 1) {
    throw new Error(
      unhandledPlannerMessage(call, tied, "ambiguous matching tools"),
    );
  }
  return best.tool;
}

function unhandledPlannerMessage(
  call: LlmProxyCall,
  scored: Array<{ score: number; tool: ToolDefinition }>,
  reason: string,
): string {
  const actual = {
    modelType: call.modelType,
    latestUserText: call.latestUserText,
    toolNames: call.toolNames,
    scores: scored.map(({ score, tool }) => ({
      name: tool.name,
      score,
      description: typeof tool.description === "string" ? tool.description : "",
    })),
  };
  return [
    `deterministic LLM proxy could not select an ACTION_PLANNER tool: ${reason}`,
    "Expected: the E2E prompt must clearly match exactly one provided action/tool.",
    `Actual: ${JSON.stringify(actual)}`,
  ].join("\n");
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

const BUILTIN_VIEW_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    /\bsettings?\b|\bpreferences?\b|\boptions\b|\bconfig(uration)?\b/,
    "settings",
  ],
  [/\bwallet\b|\bbalance\b|\bcrypto\b|\binventory\b/, "wallet"],
  [/\bcharacter\b|\bpersona\b|\bprofile\b|\bidentity\b/, "character"],
  [/\bchat\b|\bconversation\b|\bmessages?\b/, "chat"],
  [/\bmemor(y|ies)\b/, "memory"],
  [/\bskills?\b/, "skills"],
  [/\bplugins?\b/, "plugins"],
  [/\btraining\b|\btrain\b/, "training"],
  [/\bhome\b|\bdashboard\b|\bmain screen\b/, "home"],
  [/\bapps?\b/, "apps"],
];

function inferViewId(loweredText: string): string {
  if (/\bledger|finance|remote\b/.test(loweredText)) return "remote-ledger";
  if (/\btrace|diagnostic|run\b/.test(loweredText)) return "agent-run-trace";
  if (/\bnote|notes|local\b/.test(loweredText)) return "local-notes";
  for (const [pattern, viewId] of BUILTIN_VIEW_PATTERNS) {
    if (pattern.test(loweredText)) return viewId;
  }
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
    return extractPromptUserMessage(contentToText(message.content));
  }
  return extractPromptUserMessage(params.prompt ?? "");
}

function extractPromptUserMessage(text: string): string {
  const directUserMessage = text.match(
    /(?:^|\n)user_message:\s*(?<message>.+?)(?=\n[a-z_]+:|\n\n|$)/is,
  )?.groups?.message;
  if (directUserMessage) return directUserMessage.trim();
  const receivedMessage = text.match(
    /(?:^|\n)# Received Message\s*\n(?<line>[^\n]+)$/im,
  )?.groups?.line;
  if (receivedMessage) {
    const colonIndex = receivedMessage.indexOf(":");
    return (
      colonIndex >= 0 ? receivedMessage.slice(colonIndex + 1) : receivedMessage
    ).trim();
  }
  return text;
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
  if (BUILTIN_VIEW_PATTERNS.some(([pattern]) => pattern.test(text))) {
    hints.add("show");
    hints.add("open");
    hints.add("navigate");
    hints.add("view");
    hints.add("views");
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
