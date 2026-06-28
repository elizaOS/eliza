/**
 * Discord Gateway Zod Schemas
 *
 * Runtime validation for Discord gateway API payloads.
 */

import { z } from "zod";

// Discord event types supported by the gateway
export const DiscordEventTypeSchema = z.enum([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "GUILD_MEMBER_ADD",
  "GUILD_MEMBER_REMOVE",
  "INTERACTION_CREATE",
  "TYPING_START",
]);

// Discord author schema
export const DiscordAuthorSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  discriminator: z.string().optional(),
  avatar: z.string().nullable().optional(),
  bot: z.boolean().optional(),
  global_name: z.string().nullable().optional(),
});

// Discord member schema
export const DiscordMemberSchema = z.object({
  nick: z.string().nullable().optional(),
  roles: z.array(z.string()).optional(),
});

// Discord attachment schema
export const DiscordAttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().optional(),
  url: z.string().url(),
  content_type: z.string().nullable().optional(),
  size: z.number().int().positive().optional(),
});

// Voice attachment schema
export const VoiceAttachmentSchema = z.object({
  url: z.string().url(),
  expires_at: z.string().datetime(),
  size: z.number().int().positive(),
  content_type: z.string(),
  filename: z.string(),
});

// Message create event data
export const MessageCreateDataSchema = z.object({
  id: z.string().min(1),
  channel_id: z.string().min(1),
  guild_id: z.string().nullable().optional(),
  author: DiscordAuthorSchema,
  member: DiscordMemberSchema.optional(),
  content: z.string(),
  timestamp: z.string(),
  attachments: z.array(DiscordAttachmentSchema).optional(),
  embeds: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        url: z.string().optional(),
        color: z.number().optional(),
      }),
    )
    .optional(),
  mentions: z
    .array(
      z.object({
        id: z.string(),
        username: z.string(),
        bot: z.boolean().optional(),
      }),
    )
    .optional(),
  referenced_message: z.object({ id: z.string() }).optional(),
  voice_attachments: z.array(VoiceAttachmentSchema).optional(),
});

// Main event payload schema
export const DiscordEventPayloadSchema = z.object({
  connection_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  platform_connection_id: z.string(),
  event_type: DiscordEventTypeSchema,
  event_id: z.string().min(1),
  guild_id: z.string(),
  channel_id: z.string(),
  data: z.record(z.string(), z.unknown()),
  timestamp: z.string().datetime(),
});

// Connection status update schema
// K8s pod name pattern: alphanumeric with hyphens, max 253 chars
const podNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9-]+$/, "Pod name must be alphanumeric with hyphens");

export const ConnectionStatusUpdateSchema = z.object({
  connection_id: z.string().uuid(),
  pod_name: podNameSchema,
  status: z.enum(["connecting", "connected", "disconnected", "error"]),
  error_message: z.string().optional(),
  // Bot user ID - sent when status is "connected" for mention detection
  // Discord Application ID ≠ Bot User ID - mentions use user ID
  bot_user_id: z.string().optional(),
});

// Failover request schema
export const FailoverRequestSchema = z.object({
  claiming_pod: podNameSchema,
  dead_pod: podNameSchema,
});

// Type exports
export type DiscordEventPayload = z.infer<typeof DiscordEventPayloadSchema>;
export type ConnectionStatusUpdate = z.infer<typeof ConnectionStatusUpdateSchema>;
export type FailoverRequest = z.infer<typeof FailoverRequestSchema>;
export type MessageCreateData = z.infer<typeof MessageCreateDataSchema>;
