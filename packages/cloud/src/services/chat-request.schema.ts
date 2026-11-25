// spec/cloud/index.md, "Story: Use inference on my subscription or funded pilot account"
import { Schema } from "effect";

const tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

export const ImagePart = Schema.Struct({
  type: Schema.Literal("image_url"),
  image_url: Schema.Struct({
    url: Schema.String.check(Schema.isPattern(/^(?:https?:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)$/)),
    detail: Schema.optionalKey(Schema.Literals(["auto", "low", "high"])),
  }),
});

export const ContentPart = Schema.Union([TextPart, ImagePart]);
export type ContentPart = typeof ContentPart.Type;

const content = Schema.Union([Schema.String, Schema.NonEmptyArray(ContentPart)]);
const name = Schema.optionalKey(Schema.String);
const functionName = Schema.String.check(Schema.isMinLength(1));

export const ToolCall = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: functionName, arguments: Schema.String }),
});

export const ChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literals(["system", "developer", "user"]), content, name }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.optionalKey(Schema.NullOr(content)),
    name,
    tool_calls: Schema.optionalKey(Schema.NonEmptyArray(ToolCall)),
    reasoning: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), tool_call_id: Schema.String.check(Schema.isMinLength(1)), content: Schema.Union([Schema.String, Schema.NonEmptyArray(TextPart)]) }),
]);
export type ChatMessage = typeof ChatMessage.Type;

export const Tool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: functionName,
    description: Schema.optionalKey(Schema.String),
    parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    strict: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  }),
});

export const ToolChoice = Schema.Union([
  Schema.Literals(["none", "auto", "required"]),
  Schema.Struct({ type: Schema.Literal("function"), function: Schema.Struct({ name: functionName }) }),
]);

const penalty = Schema.Finite.check(Schema.isBetween({ minimum: -2, maximum: 2 }));

export const JsonSchemaFormat = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  description: Schema.optionalKey(Schema.String),
  schema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  strict: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

export const ResponseFormat = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text") }),
  Schema.Struct({ type: Schema.Literal("json_object") }),
  Schema.Struct({ type: Schema.Literal("json_schema"), json_schema: JsonSchemaFormat }),
]);
export type ResponseFormat = typeof ResponseFormat.Type;

export const ChatRequest = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1)),
  messages: Schema.NonEmptyArray(ChatMessage),
  stream: Schema.optionalKey(Schema.Boolean),
  stream_options: Schema.optionalKey(Schema.Struct({ include_usage: Schema.optionalKey(Schema.Boolean) })),
  temperature: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
  max_tokens: Schema.optionalKey(tokens),
  max_completion_tokens: Schema.optionalKey(tokens),
  reasoning_effort: Schema.optionalKey(Schema.Literals(["none", "minimal", "low", "medium", "high"])),
  response_format: Schema.optionalKey(ResponseFormat),
  tools: Schema.optionalKey(Schema.NonEmptyArray(Tool)),
  tool_choice: Schema.optionalKey(ToolChoice),
  top_p: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  stop: Schema.optionalKey(Schema.Union([Schema.String, Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(4))])),
  seed: Schema.optionalKey(Schema.Int),
  frequency_penalty: Schema.optionalKey(penalty),
  presence_penalty: Schema.optionalKey(penalty),
  prompt_cache_key: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
});
export type ChatRequest = typeof ChatRequest.Type;
