/** Lossless wire conversion into the existing chat admission owner. */
export class ResponsesInputError extends Error {
  constructor(
    message: string,
    readonly code = "invalid_request_error",
  ) {
    super(message);
    this.name = "ResponsesInputError";
  }
}

export class ResponsesOutputError extends Error {
  constructor() {
    super("Canonical chat response is incomplete or malformed");
    this.name = "ResponsesOutputError";
  }
}

type JsonObject = Record<string, unknown>;
type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { file_data: string; filename?: string } };
type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export interface ResponsesChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}
export interface ParsedResponsesRequest {
  model: string;
  messages: ResponsesChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: JsonObject[];
  tool_choice?: unknown;
  response_format?: JsonObject;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ResponsesInputError(`${label} must be an object`);
  return value as JsonObject;
}
function keys(value: JsonObject, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown)
    throw new ResponsesInputError(
      `Unsupported ${label} field: ${unknown}`,
      "unsupported_parameter",
    );
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new ResponsesInputError(`${label} must be a string`);
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result.trim())
    throw new ResponsesInputError(`${label} must not be empty`);
  return result;
}
function number(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ResponsesInputError(`${label} must be a finite number`);
  return value;
}

interface DecimalToken {
  negative: boolean;
  digits: string;
  shift: number;
  exponent: string;
}

/** Keep exponents symbolic so even very long input exponents need no expansion. */
function decimalToken(token: string): DecimalToken {
  const negative = token.startsWith("-");
  const unsigned = negative ? token.slice(1) : token;
  const exponentAt = unsigned.search(/[eE]/);
  const mantissa = exponentAt < 0 ? unsigned : unsigned.slice(0, exponentAt);
  const rawExponent = exponentAt < 0 ? "0" : unsigned.slice(exponentAt + 1);
  const dot = mantissa.indexOf(".");
  const fractionLength = dot < 0 ? 0 : mantissa.length - dot - 1;
  const allDigits =
    dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  let start = 0;
  while (start < allDigits.length && allDigits[start] === "0") start++;
  let end = allDigits.length;
  while (end > start && allDigits[end - 1] === "0") end--;
  const exponentNegative = rawExponent.startsWith("-");
  const exponentDigits =
    rawExponent.replace(/^[+-]/, "").replace(/^0+/, "") || "0";
  return {
    negative,
    digits: allDigits.slice(start, end) || "0",
    shift: allDigits.length - end - fractionLength,
    exponent:
      exponentNegative && exponentDigits !== "0"
        ? `-${exponentDigits}`
        : exponentDigits,
  };
}

function assertNumericRoundTrip(token: string): void {
  const serialized = JSON.stringify(Number(token));
  const fail = (): never => {
    throw new ResponsesInputError(
      "Function arguments contain a number whose value or sign cannot be preserved by chat admission",
      "unsupported_parameter",
    );
  };
  if (typeof serialized !== "string" || serialized === "null") fail();
  const source = decimalToken(token);
  const target = decimalToken(serialized);
  if (source.negative !== target.negative || source.digits !== target.digits)
    fail();
  if (source.digits === "0") return;
  // The serialized finite number has a small exponent; the source exponent
  // remains a string. Only input-length offsets enter bigint arithmetic.
  const requiredExponent =
    BigInt(target.exponent) + BigInt(target.shift) - BigInt(source.shift);
  if (source.exponent !== requiredExponent.toString()) fail();
}

/** JSON.parse is required by the chat SDK, but it must not silently rewrite numeric history. */
function assertArgumentNumbersPreserved(source: string): void {
  const token = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '"') {
      for (index++; index < source.length; index++) {
        if (source[index] === "\\") index++;
        else if (source[index] === '"') break;
      }
      continue;
    }
    if (source[index] !== "-" && (source[index] < "0" || source[index] > "9"))
      continue;
    token.lastIndex = index;
    const match = token.exec(source);
    if (!match)
      throw new ResponsesInputError("Function arguments must be a JSON object");
    assertNumericRoundTrip(match[0]);
    index = token.lastIndex - 1;
  }
}

function content(
  value: unknown,
  role: ResponsesChatMessage["role"],
): string | ChatPart[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value))
    throw new ResponsesInputError("Message content must be text or an array");
  return value.map((raw): ChatPart => {
    const part = object(raw, "Content part");
    const type = part.type;
    if (type === "input_image") {
      keys(part, ["type", "image_url", "detail"], "image");
      if (role !== "user")
        throw new ResponsesInputError("Images require a user message");
      if (part.detail !== undefined && part.detail !== "auto")
        throw new ResponsesInputError(
          "Explicit image detail is not supported by chat admission",
          "unsupported_parameter",
        );
      return {
        type: "image_url",
        image_url: { url: identifier(part.image_url, "image_url") },
      };
    }
    if (type === "input_file") {
      keys(part, ["type", "file_data", "filename"], "file");
      if (role !== "user")
        throw new ResponsesInputError("Files require a user message");
      return {
        type: "file",
        file: {
          file_data: identifier(part.file_data, "file_data"),
          ...(part.filename === undefined
            ? {}
            : { filename: string(part.filename, "filename") }),
        },
      };
    }
    if (
      type !== undefined &&
      type !== "input_text" &&
      type !== "output_text" &&
      type !== "text"
    )
      throw new ResponsesInputError(
        `Unsupported input content type: ${String(type)}`,
        "unsupported_parameter",
      );
    keys(
      part,
      ["type", "text", "input_text", "output_text", "annotations"],
      "text",
    );
    if (
      part.annotations !== undefined &&
      (!Array.isArray(part.annotations) || part.annotations.length > 0)
    )
      throw new ResponsesInputError(
        "Annotated input is not supported",
        "unsupported_parameter",
      );
    const fields = ["text", "input_text", "output_text"].filter(
      (key) => part[key] !== undefined,
    );
    if (fields.length !== 1)
      throw new ResponsesInputError(
        "Text content requires exactly one text value",
      );
    return { type: "text", text: string(part[fields[0]], "Content text") };
  });
}

/** Retain order, text bytes, media and original tool identities; never omit an unsupported item. */
export function parseResponsesRequest(raw: unknown): ParsedResponsesRequest {
  const body = object(raw, "Request body");
  keys(
    body,
    [
      "model",
      "instructions",
      "input",
      "temperature",
      "max_output_tokens",
      "max_tokens",
      "top_p",
      "stream",
      "tools",
      "tool_choice",
      "text",
      "store",
    ],
    "request",
  );
  if (
    body.model === undefined ||
    body.model === null ||
    (typeof body.model === "string" && !body.model.trim())
  )
    throw new ResponsesInputError(
      "Missing required field: model",
      "missing_required_parameter",
    );
  const model = identifier(body.model, "model").trim();
  if (body.stream !== undefined && body.stream !== false)
    throw new ResponsesInputError(
      "Streaming is not supported on /api/v1/responses. Use /api/v1/chat/completions for streaming.",
    );
  if (body.store !== undefined && body.store !== false)
    throw new ResponsesInputError(
      "Stored Responses are not supported",
      "unsupported_parameter",
    );
  const messages: ResponsesChatMessage[] = [];
  if (body.instructions !== undefined && body.instructions !== null)
    messages.push({
      role: "system",
      content: string(body.instructions, "instructions"),
    });
  const calls = new Set<string>();
  const pendingCalls = new Set<string>();
  let callBatch: ResponsesChatMessage | undefined;
  let receivingOutputs = false;
  if (typeof body.input === "string")
    messages.push({ role: "user", content: body.input });
  else if (Array.isArray(body.input)) {
    for (const rawItem of body.input) {
      const item = object(rawItem, "Input item");
      if (item.id !== undefined) identifier(item.id, "Item id");
      if (item.status !== undefined && item.status !== "completed")
        throw new ResponsesInputError(
          "Only completed input items are supported",
          "unsupported_parameter",
        );
      if (item.type === "function_call") {
        keys(
          item,
          ["type", "id", "call_id", "name", "arguments", "status"],
          "function call",
        );
        const id = identifier(item.call_id, "call_id");
        if (calls.has(id))
          throw new ResponsesInputError("Duplicate function call identity");
        if (receivingOutputs && pendingCalls.size)
          throw new ResponsesInputError(
            "Complete all function outputs before the next call",
          );
        const args = string(item.arguments, "Function arguments");
        let parsed: unknown;
        try {
          parsed = JSON.parse(args);
        } catch {
          throw new ResponsesInputError(
            "Function arguments must be a JSON object",
          );
        }
        object(parsed, "Function arguments");
        assertArgumentNumbersPreserved(args);
        calls.add(id);
        pendingCalls.add(id);
        if (!callBatch || receivingOutputs) {
          callBatch = { role: "assistant", content: null, tool_calls: [] };
          messages.push(callBatch);
          receivingOutputs = false;
        }
        callBatch.tool_calls!.push({
          id,
          type: "function",
          function: {
            name: identifier(item.name, "Function name"),
            arguments: args,
          },
        });
        continue;
      }
      if (item.type === "function_call_output") {
        keys(
          item,
          ["type", "id", "call_id", "output", "status"],
          "function output",
        );
        const id = identifier(item.call_id, "call_id");
        if (!pendingCalls.delete(id))
          throw new ResponsesInputError(
            "Function output requires one pending original call in input",
          );
        receivingOutputs = true;
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: string(item.output, "Function output"),
        });
        continue;
      }
      if (item.type !== undefined && item.type !== "message")
        throw new ResponsesInputError(
          `Unsupported input item: ${String(item.type)}`,
          "unsupported_parameter",
        );
      if (pendingCalls.size)
        throw new ResponsesInputError(
          "Complete all function outputs before the next message",
        );
      callBatch = undefined;
      receivingOutputs = false;
      keys(item, ["type", "id", "role", "content", "status"], "message");
      const role = item.role ?? "user";
      if (
        typeof role !== "string" ||
        !["system", "developer", "assistant", "user"].includes(role)
      )
        throw new ResponsesInputError("Unsupported message role");
      const mappedRole =
        role === "developer"
          ? "system"
          : (role as ResponsesChatMessage["role"]);
      const value = content(item.content, mappedRole);
      messages.push({ role: mappedRole, content: value });
    }
  } else if (body.input !== undefined && body.input !== null) {
    throw new ResponsesInputError("input must be text or an array");
  }
  if (pendingCalls.size)
    throw new ResponsesInputError(
      "Function calls require their outputs before inference",
    );
  if (!messages.length)
    throw new ResponsesInputError(
      "Missing required field: input",
      "missing_required_parameter",
    );
  const maxOutput = number(body.max_output_tokens, "max_output_tokens");
  const legacyMax = number(body.max_tokens, "max_tokens");
  if (
    maxOutput !== undefined &&
    legacyMax !== undefined &&
    maxOutput !== legacyMax
  )
    throw new ResponsesInputError("Conflicting output token limits");
  const maxTokens = maxOutput ?? legacyMax;
  if (
    maxTokens !== undefined &&
    (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
  )
    throw new ResponsesInputError(
      "Output token limit must be a positive safe integer",
    );
  const result: ParsedResponsesRequest = {
    model,
    messages,
    temperature: number(body.temperature, "temperature"),
    max_tokens: maxTokens,
    top_p: number(body.top_p, "top_p"),
  };
  if (
    result.temperature !== undefined &&
    (result.temperature < 0 || result.temperature > 2)
  )
    throw new ResponsesInputError("temperature must be between 0 and 2");
  if (result.top_p !== undefined && (result.top_p < 0 || result.top_p > 1))
    throw new ResponsesInputError("top_p must be between 0 and 1");
  const toolNames = new Set<string>();
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools))
      throw new ResponsesInputError("tools must be an array");
    result.tools = body.tools.map((rawTool) => {
      const tool = object(rawTool, "Tool");
      keys(
        tool,
        ["type", "name", "description", "parameters", "strict"],
        "tool",
      );
      if (tool.type !== "function")
        throw new ResponsesInputError(
          "Only function tools are supported",
          "unsupported_parameter",
        );
      const name = identifier(tool.name, "Tool name");
      if (toolNames.has(name))
        throw new ResponsesInputError("Duplicate function tool name");
      toolNames.add(name);
      if (tool.description !== undefined)
        string(tool.description, "Tool description");
      if (tool.parameters !== undefined && tool.parameters !== null)
        object(tool.parameters, "Tool parameters");
      if (
        tool.strict !== undefined &&
        tool.strict !== null &&
        typeof tool.strict !== "boolean"
      )
        throw new ResponsesInputError("Tool strict must be boolean");
      const { type: _, ...definition } = tool;
      return { type: "function", function: definition };
    });
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    if (
      typeof body.tool_choice === "string" &&
      ["auto", "none", "required"].includes(body.tool_choice)
    )
      result.tool_choice = body.tool_choice;
    else {
      const choice = object(body.tool_choice, "tool_choice");
      keys(choice, ["type", "name"], "tool_choice");
      if (choice.type !== "function")
        throw new ResponsesInputError("Unsupported tool_choice");
      const name = identifier(choice.name, "Tool name");
      if (!toolNames.has(name))
        throw new ResponsesInputError(
          "tool_choice must name an available tool",
        );
      result.tool_choice = { type: "function", function: { name } };
    }
  }
  if (result.tool_choice === "required" && !toolNames.size)
    throw new ResponsesInputError(
      "Required tool choice needs an available tool",
    );
  if (body.text !== undefined && body.text !== null) {
    const text = object(body.text, "text");
    keys(text, ["format"], "text");
    const format = object(text.format ?? { type: "text" }, "text.format");
    if (format.type === "text" || format.type === "json_object") {
      keys(format, ["type"], "text.format");
      result.response_format = format;
    } else if (format.type === "json_schema") {
      keys(
        format,
        ["type", "name", "description", "schema", "strict"],
        "text.format",
      );
      identifier(format.name, "Schema name");
      object(format.schema, "Schema");
      if (format.description !== undefined)
        string(format.description, "Schema description");
      // The canonical SDK currently requests strict schemas; never pretend to honor false.
      if (
        format.strict !== undefined &&
        format.strict !== null &&
        format.strict !== true
      )
        throw new ResponsesInputError(
          "Non-strict output schemas are not supported",
          "unsupported_parameter",
        );
      const { type: _, ...schema } = format;
      result.response_format = { type: "json_schema", json_schema: schema };
    } else
      throw new ResponsesInputError(
        "Unsupported text format",
        "unsupported_parameter",
      );
  }
  return result;
}

function responseObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ResponsesOutputError();
  return value as JsonObject;
}
function responseString(value: unknown): string {
  if (typeof value !== "string") throw new ResponsesOutputError();
  return value;
}
function natural(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ResponsesOutputError();
  return value;
}

/** A provider limit remains incomplete; missing output is never fabricated as success. */
export function mapChatCompletionToResponse(raw: unknown) {
  const payload = responseObject(raw);
  const id = responseString(payload.id);
  if (!id.length || !responseString(payload.model).length)
    throw new ResponsesOutputError();
  const created = natural(payload.created);
  if (!Array.isArray(payload.choices) || payload.choices.length !== 1)
    throw new ResponsesOutputError();
  const choice = responseObject(payload.choices[0]);
  const reason = choice.finish_reason;
  if (
    typeof reason !== "string" ||
    !["stop", "length", "content_filter", "tool_calls"].includes(reason)
  )
    throw new ResponsesOutputError();
  const message = responseObject(choice.message);
  if (message.role !== "assistant") throw new ResponsesOutputError();
  const incomplete = reason === "length" || reason === "content_filter";
  const status = incomplete ? "incomplete" : "completed";
  const output: JsonObject[] = [];
  const parts: JsonObject[] = [];
  if (message.content !== undefined && message.content !== null)
    parts.push({
      type: "output_text",
      text: responseString(message.content),
      annotations: [],
    });
  if (message.refusal !== undefined && message.refusal !== null)
    parts.push({ type: "refusal", refusal: responseString(message.refusal) });
  if (parts.length)
    output.push({
      id: `msg_${id}`,
      type: "message",
      status,
      role: "assistant",
      content: parts,
    });
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls)) throw new ResponsesOutputError();
    const callIds = new Set<string>();
    for (const rawCall of message.tool_calls) {
      const call = responseObject(rawCall);
      const fn = responseObject(call.function);
      const callId = responseString(call.id);
      const name = responseString(fn.name);
      if (
        call.type !== "function" ||
        !callId.trim() ||
        !name.trim() ||
        callIds.has(callId)
      )
        throw new ResponsesOutputError();
      callIds.add(callId);
      output.push({
        id: `fc_${callId}`,
        type: "function_call",
        status,
        call_id: call.id,
        name,
        arguments: responseString(fn.arguments),
      });
    }
  }
  if (
    reason === "tool_calls" &&
    !output.some((item) => item.type === "function_call")
  )
    throw new ResponsesOutputError();
  if (!output.length && !incomplete) throw new ResponsesOutputError();
  let usage: JsonObject | null = null;
  if (payload.usage !== undefined && payload.usage !== null) {
    const source = responseObject(payload.usage);
    usage = {
      input_tokens: natural(source.prompt_tokens),
      output_tokens: natural(source.completion_tokens),
      total_tokens: natural(source.total_tokens),
    };
    if (source.prompt_tokens_details !== undefined)
      usage.input_tokens_details = responseObject(source.prompt_tokens_details);
    if (source.completion_tokens_details !== undefined)
      usage.output_tokens_details = responseObject(
        source.completion_tokens_details,
      );
  }
  return {
    id: id.startsWith("resp_") ? id : `resp_${id}`,
    object: "response",
    created_at: created,
    model: payload.model,
    status,
    error: null,
    incomplete_details: incomplete
      ? { reason: reason === "length" ? "max_output_tokens" : "content_filter" }
      : null,
    output,
    output_text: parts
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join(""),
    usage,
  };
}
