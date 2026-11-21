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

export const ChatMessage = Schema.Struct({
  role: Schema.Literals(["system", "developer", "user", "assistant"]),
  content: Schema.Union([Schema.String, Schema.NonEmptyArray(ContentPart)]),
});
export type ChatMessage = typeof ChatMessage.Type;

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
});
export type ChatRequest = typeof ChatRequest.Type;

export const acceptedFields: ReadonlyArray<string> = Object.keys(ChatRequest.fields);
