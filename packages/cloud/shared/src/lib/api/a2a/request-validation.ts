/**
 * Validates untrusted A2A v0.3 envelopes and messages before authentication,
 * persistence, billing, or provider dispatch. Client messages are user-authored;
 * protocol `agent` is accepted only in chat history and normalized separately.
 */
import { z } from "zod";
import type { JSONRPCRequest, MessageSendParams } from "../../types/a2a";
import { UntrustedA2AChatMessagesSchema } from "./chat-messages";

export type JsonRpcId = string | number | null;

const JsonRpcIdSchema = z.union([z.string(), z.number().finite(), z.null()]);
const MetadataSchema = z.record(z.string(), z.unknown());

const LegacyTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1),
    metadata: MetadataSchema.optional(),
  })
  .strict();

const ProtocolTextPartSchema = z
  .object({
    kind: z.literal("text"),
    text: z.string().min(1),
    metadata: MetadataSchema.optional(),
  })
  .strict();

const TextPartSchema = z
  .union([LegacyTextPartSchema, ProtocolTextPartSchema])
  .transform((part) => ({ type: "text" as const, text: part.text, metadata: part.metadata }));

const FilePayloadSchema = z.union([
  z
    .object({
      name: z.string().optional(),
      mimeType: z.string().optional(),
      bytes: z.string().min(1),
    })
    .strict(),
  z
    .object({
      name: z.string().optional(),
      mimeType: z.string().optional(),
      uri: z.string().min(1),
    })
    .strict(),
]);

const LegacyFilePartSchema = z
  .object({
    type: z.literal("file"),
    file: FilePayloadSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

const ProtocolFilePartSchema = z
  .object({
    kind: z.literal("file"),
    file: FilePayloadSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

const FilePartSchema = z
  .union([LegacyFilePartSchema, ProtocolFilePartSchema])
  .transform((part) => ({ type: "file" as const, file: part.file, metadata: part.metadata }));

const DataContentSchema = z.record(z.string(), z.unknown()).transform((data, ctx) => {
  if (!Object.hasOwn(data, "messages")) return data;

  const messages = UntrustedA2AChatMessagesSchema.safeParse(data.messages);
  if (!messages.success) {
    ctx.addIssue({
      code: "custom",
      message: "data.messages must contain caller-safe A2A chat history",
      path: ["messages"],
    });
    return z.NEVER;
  }
  return { ...data, messages: messages.data };
});

const LegacyDataPartSchema = z
  .object({
    type: z.literal("data"),
    data: DataContentSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

const ProtocolDataPartSchema = z
  .object({
    kind: z.literal("data"),
    data: DataContentSchema,
    metadata: MetadataSchema.optional(),
  })
  .strict();

const DataPartSchema = z
  .union([LegacyDataPartSchema, ProtocolDataPartSchema])
  .transform((part) => ({ type: "data" as const, data: part.data, metadata: part.metadata }));

export const UntrustedA2AInboundMessageSchema = z
  .object({
    kind: z.literal("message").optional(),
    messageId: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    role: z.literal("user"),
    parts: z.array(z.union([TextPartSchema, FilePartSchema, DataPartSchema])).min(1),
    metadata: MetadataSchema.optional(),
    extensions: z.array(z.string().min(1)).optional(),
    referenceTaskIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .transform(({ kind: _kind, ...message }) => message);

const PushNotificationAuthenticationSchema = z
  .object({
    schemes: z.array(z.string()).min(1),
    credentials: z.string().optional(),
  })
  .strict();

const PushNotificationConfigSchema = z
  .object({
    url: z.string().min(1),
    token: z.string().optional(),
    authentication: PushNotificationAuthenticationSchema.optional(),
  })
  .strict();

const MessageSendConfigurationSchema = z
  .object({
    acceptedOutputModes: z.array(z.string()).optional(),
    historyLength: z.number().int().nonnegative().optional(),
    pushNotificationConfig: PushNotificationConfigSchema.optional(),
    blocking: z.boolean().optional(),
  })
  .strict();

export const UntrustedA2AMessageSendParamsSchema = z
  .object({
    message: UntrustedA2AInboundMessageSchema,
    configuration: MessageSendConfigurationSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();

export const A2AJsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    id: JsonRpcIdSchema,
  })
  .strict();

export function jsonRpcIdFromUnknown(value: unknown): JsonRpcId {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = JsonRpcIdSchema.safeParse((value as Record<string, unknown>).id);
  return result.success ? result.data : null;
}

export function parseA2AJsonRpcRequest(value: unknown): JSONRPCRequest {
  return A2AJsonRpcRequestSchema.parse(value);
}

export function parseUntrustedA2AMessageSendParams(value: unknown): MessageSendParams {
  return UntrustedA2AMessageSendParamsSchema.parse(value);
}
