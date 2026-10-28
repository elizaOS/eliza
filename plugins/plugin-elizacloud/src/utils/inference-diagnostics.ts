/** Content-free last-failure facts. Never retain a request, error, or response. */
/** Schema features for diagnosis; support varies by provider/model. */
export const INFERENCE_SCHEMA_KEYWORDS = [
  "pattern",
  "minLength",
  "maxLength",
  "format",
  "minItems",
  "maxItems",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "unevaluatedProperties",
  "$anchor",
] as const;
export const INFERENCE_PARAMETERS = [
  "tools",
  "response_format",
  "tool_choice",
  "messages",
  "model",
  "max_tokens",
  "temperature",
  "reasoning_effort",
] as const;
export const INFERENCE_TOOL_NAMES = [
  "HANDLE_RESPONSE",
  "READ_CONTEXT",
  "RESTORE_CONTEXT",
  "PROPOSE_DEVICE_ACTION",
  "DISCOVER_ACTIONS",
  "FINISH",
  "REPLY",
  "IGNORE",
  "STOP",
  "FACTS_AND_RELATIONSHIPS_VALIDATE",
  "other",
] as const;
export type CloudInferenceFailure = {
  version: 1;
  at: number;
  stage: "response-handler" | "action-planner" | "text" | "other";
  status?: number;
  reason:
    | "unsupported-schema-keyword"
    | "schema-limit"
    | "invalid-parameter"
    | "context-window"
    | "unavailable-model"
    | "rate-limit"
    | "credits"
    | "transport"
    | "unknown";
  parameter?: (typeof INFERENCE_PARAMETERS)[number];
  keyword?: (typeof INFERENCE_SCHEMA_KEYWORDS)[number];
  strictTools: (typeof INFERENCE_TOOL_NAMES)[number][];
  schemaKeywords: (typeof INFERENCE_SCHEMA_KEYWORDS)[number][];
  schemaScanTruncated: boolean;
  /** Aggregate emitted schema counts; references are not expanded. */
  schemaDepth?: number;
  schemaProperties?: number;
  schemaEnumValues?: number;
  /** Unicode code points in property/definition names and string enum/const values. */
  schemaTextChars?: number;
};
const failures = new WeakMap<object, CloudInferenceFailure>();
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Returns a copy: consumers cannot mutate the diagnostic retained for this runtime. */
export function getCloudInferenceFailure(runtime: object): CloudInferenceFailure | undefined {
  const value = failures.get(runtime);
  return value
    ? { ...value, strictTools: [...value.strictTools], schemaKeywords: [...value.schemaKeywords] }
    : undefined;
}

/** Best effort only; diagnostics cannot replace the original model failure. */
export function recordCloudInferenceFailure(
  runtime: object,
  modelType: string,
  request: unknown,
  error: unknown
): void {
  try {
    const failure = record(error),
      nested = record(failure.error);
    const status =
      typeof failure.status === "number" &&
      Number.isInteger(failure.status) &&
      failure.status >= 400 &&
      failure.status <= 599
        ? failure.status
        : undefined;
    // Examine only bounded known error fields in memory. Never copy their text.
    const message = [failure.message, nested.message]
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.slice(0, 2048).toLowerCase())
      .join(" ");
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parameter = INFERENCE_PARAMETERS.find(
      (p) =>
        nested.param === p ||
        failure.param === p ||
        new RegExp(
          `(?:unsupported|invalid|unknown) (?:parameter|argument)[ :"']{1,8}${escaped(p)}(?:$|[ ",.])`
        ).test(message)
    );
    const keyword = INFERENCE_SCHEMA_KEYWORDS.find((k) =>
      new RegExp(
        `(?:unsupported (?:schema )?keyword[ :"']{1,8}${escaped(k.toLowerCase())}(?:$|[ ",.])|${escaped(k.toLowerCase())}["']? (?:is )?(?:not supported|not permitted|not allowed))`
      ).test(message)
    );
    let reason: CloudInferenceFailure["reason"] = "unknown";
    if (keyword) reason = "unsupported-schema-keyword";
    else if (
      status !== undefined &&
      /(?:schema|json schema).{0,80}(?:maximum|limit|too large|too deep)|(?:maximum|too many).{0,40}(?:properties|enum values)|(?:nesting|schema string).{0,40}(?:exceed|limit|maximum)/.test(
        message
      )
    )
      reason = "schema-limit";
    else if (status === 429) reason = "rate-limit";
    else if (status === 402) reason = "credits";
    else if (status !== undefined && /context (window|length)|maximum context/.test(message))
      reason = "context-window";
    else if (
      status !== undefined &&
      /model/.test(message) &&
      /not found|unavailable|does not exist/.test(message)
    )
      reason = "unavailable-model";
    else if (parameter && (status === 400 || status === 422)) reason = "invalid-parameter";
    else if (
      (typeof failure.code === "string" &&
        ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(failure.code)) ||
      failure.name === "TimeoutError"
    )
      reason = "transport";
    const strictTools = new Set<CloudInferenceFailure["strictTools"][number]>(),
      keywords = new Set<CloudInferenceFailure["schemaKeywords"][number]>();
    let remaining = 2048,
      truncated = false;
    let schemaDepth = 0,
      schemaProperties = 0,
      schemaEnumValues = 0,
      schemaTextChars = 0;
    const addText = (value: string) => {
      for (const _character of value) {
        if (schemaTextChars >= 100_000) {
          truncated = true;
          break;
        }
        schemaTextChars++;
      }
    };
    const walk = (schema: unknown, depth: number): void => {
      if (schema === null || typeof schema !== "object") return;
      if (depth > 24 || --remaining < 0) {
        truncated = true;
        return;
      }
      schemaDepth = Math.max(schemaDepth, depth);
      const node = record(schema);
      // These schema-valued containers are not expanded by this bounded scanner.
      // Mark counts incomplete rather than silently claiming a complete scan.
      for (const key of [
        "prefixItems",
        "additionalItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "dependentSchemas",
        "patternProperties",
        "propertyNames",
        "additionalProperties",
        "unevaluatedProperties",
        "unevaluatedItems",
      ]) {
        if (node[key] !== null && typeof node[key] === "object") truncated = true;
      }
      if (Array.isArray(node.items)) truncated = true;
      if (Object.hasOwn(node, "$ref")) truncated = true;
      if (typeof node.const === "string") addText(node.const);
      if (Array.isArray(node.enum)) {
        schemaEnumValues = Math.min(100_000, schemaEnumValues + node.enum.length);
        if (node.enum.length > 1024 || schemaEnumValues >= 100_000) truncated = true;
        for (const value of node.enum.slice(0, 1024)) if (typeof value === "string") addText(value);
      }
      for (const key of INFERENCE_SCHEMA_KEYWORDS) if (Object.hasOwn(node, key)) keywords.add(key);
      for (const key of ["properties", "$defs", "definitions"]) {
        const children = record(node[key]);
        let count = 0;
        for (const name in children) {
          if (++count > 256 || remaining < 0) {
            truncated = true;
            break;
          }
          if (Object.hasOwn(children, name)) {
            addText(name);
            if (key === "properties") schemaProperties++;
            walk(children[name], key === "properties" ? depth + 1 : depth);
          }
        }
      }
      if (node.items) walk(node.items, depth + 1);
      for (const key of ["anyOf", "oneOf", "allOf"]) {
        const children = node[key];
        if (Array.isArray(children)) {
          if (children.length > 256) truncated = true;
          for (const child of children.slice(0, 256)) walk(child, depth);
        }
      }
    };
    const tools = record(request).tools;
    if (Array.isArray(tools)) {
      if (tools.length > 256) truncated = true;
      for (const raw of tools.slice(0, 256)) {
        const entry = record(raw);
        const tool = entry.function !== undefined ? record(entry.function) : entry;
        if (tool.strict !== true) continue;
        strictTools.add(INFERENCE_TOOL_NAMES.find((name) => name === tool.name) ?? "other");
        walk(tool.parameters, 1);
      }
    }
    // Chat Completions and Responses use different strict schema envelopes.
    const body = record(request);
    const responseFormat = record(body.response_format);
    const chatSchema = record(responseFormat.json_schema);
    if (responseFormat.type === "json_schema" && chatSchema.strict === true)
      walk(chatSchema.schema, 1);
    const responseSchema = record(record(body.text).format);
    if (responseSchema.type === "json_schema" && responseSchema.strict === true)
      walk(responseSchema.schema, 1);
    failures.set(runtime, {
      version: 1,
      at: Date.now(),
      stage:
        modelType === "RESPONSE_HANDLER"
          ? "response-handler"
          : modelType === "ACTION_PLANNER"
            ? "action-planner"
            : modelType.startsWith("TEXT_")
              ? "text"
              : "other",
      ...(status !== undefined ? { status } : {}),
      reason,
      ...(parameter ? { parameter } : {}),
      ...(keyword ? { keyword } : {}),
      strictTools: [...strictTools].sort(),
      schemaKeywords: [...keywords].sort(),
      schemaScanTruncated: truncated,
      schemaDepth,
      schemaProperties,
      schemaEnumValues,
      schemaTextChars,
    });
  } catch {
    /* The original error remains authoritative, including hostile getters. */
  }
}
