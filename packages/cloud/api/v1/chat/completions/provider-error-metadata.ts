/** Finite diagnostic categories only: provider bodies may echo private request data. */
const ERROR_CODES = new Set([
  "invalid_request_error",
  "invalid_request",
  "invalid_json_schema",
  "schema_validation_error",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_value",
  "invalid_type",
  "context_length_exceeded",
  "tool_use_failed",
  "rate_limit_exceeded",
  "insufficient_quota",
  "authentication_error",
]);
const PARAMETERS = [
  "tools",
  "tool_choice",
  "messages",
  "response_format",
  "reasoning_effort",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "model",
  "stream",
  "parallel_tool_calls",
] as const;
const SCHEMA_KEYWORDS = [
  "additionalProperties",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "oneOf",
  "anyOf",
  "allOf",
  "required",
  "enum",
  "items",
  "properties",
  "strict",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "$ref",
  "$defs",
] as const;
const MAX_DIAGNOSTIC_BODY_LENGTH = 32_768;

function field(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    // error-policy:J7 diagnostic property access must not replace the failure.
    return undefined;
  }
}

function parseBody(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_DIAGNOSTIC_BODY_LENGTH) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // error-policy:J7 invalid provider diagnostics must not replace the failure.
    return undefined;
  }
}

/** Does not return any provider-owned string, path, message, body, or identifier. */
export function getSafeProviderErrorMetadata(
  error: unknown,
): Record<string, unknown> {
  let current = error;
  const seen = new Set<unknown>();
  const result: Record<string, unknown> = {};
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth++) {
    seen.add(current);
    const status = field(current, "statusCode");
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      result.upstreamStatus = status;
      const data =
        parseBody(field(current, "responseBody")) ?? field(current, "data");
      const detail = field(data, "error") ?? data;
      for (const [input, output] of [
        ["code", "providerErrorCode"],
        ["type", "providerErrorType"],
      ] as const) {
        const value = field(detail, input);
        if (typeof value === "string" && ERROR_CODES.has(value))
          result[output] = value;
      }
      const param = field(detail, "param");
      if (typeof param === "string" && param.length <= 512) {
        const category = PARAMETERS.find(
          (name) =>
            param === name ||
            param.startsWith(`${name}.`) ||
            param.startsWith(`${name}[`),
        );
        if (category) result.parameterCategory = category;
      }
      const message = field(detail, "message");
      if (
        typeof message === "string" &&
        message.length <= MAX_DIAGNOSTIC_BODY_LENGTH
      ) {
        // Match only fixed vocabulary. Never log excerpts, even for unknown errors.
        const keywords = SCHEMA_KEYWORDS.filter(
          (keyword) =>
            message.includes(`'${keyword}'`) ||
            message.includes(`"${keyword}"`),
        );
        if (keywords.length) result.schemaKeywords = keywords;
        if (/invalid (?:json )?schema|schema.*not supported/i.test(message))
          result.reasonClass = "invalid_schema";
        else if (
          /unsupported parameter|parameter.*not supported/i.test(message)
        )
          result.reasonClass = "unsupported_parameter";
        else if (
          /tool_call_id|tool.*response.*missing|tool.*messages.*preced/i.test(
            message,
          )
        )
          result.reasonClass = "invalid_tool_history";
      }
    }
    current = field(current, "lastError") ?? field(current, "cause");
  }
  return result;
}
