/**
 * Chat-related validation schemas
 */

import { z } from 'zod';
import {
  createTrimmedStringSchema,
  PaginationSchema,
  SnowflakeIdSchema,
  UserIdSchema,
} from './common';

/**
 * Chat message content schema
 */
export const ChatMessageContentSchema = createTrimmedStringSchema(1, 5000);

/**
 * Chat message submission schema
 */
export const ChatMessageCreateSchema = z.object({
  content: ChatMessageContentSchema,
  replyToMessageId: z.string().min(1).optional(),
});

/**
 * Canonical list of supported reaction emojis.
 * Used by both the API (server-side validation) and the UI (picker).
 */
export const ALLOWED_REACTION_EMOJIS = [
  '👍',
  '❤️',
  '😂',
  '🔥',
  '😮',
  '😢',
  '🙏',
] as const;

/** Set for O(1) membership checks on the server. */
export const ALLOWED_REACTION_EMOJI_SET = new Set<string>(
  ALLOWED_REACTION_EMOJIS
);

/**
 * Chat message reaction emoji schema
 */
export const ChatMessageReactionEmojiSchema = createTrimmedStringSchema(1, 16);

/**
 * Chat message reaction submission schema
 */
export const ChatMessageReactionCreateSchema = z.object({
  emoji: ChatMessageReactionEmojiSchema,
});

/**
 * Chat creation schema
 */
export const ChatCreateSchema = z
  .object({
    name: createTrimmedStringSchema(1, 100).optional(),
    isGroup: z.boolean().optional().default(false),
    participantIds: z.array(SnowflakeIdSchema).optional(),
    requiredNftContractAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid contract address format')
      .optional(),
    requiredNftTokenId: z.number().int().min(0).nullable().optional(),
    requiredNftChainId: z.number().int().positive().optional(),
  })
  .refine((data) => !data.isGroup || data.name !== undefined, {
    message: 'Group name is required for group chats',
    path: ['name'],
  })
  .refine(
    (data) =>
      data.requiredNftTokenId === null ||
      data.requiredNftTokenId === undefined ||
      (data.requiredNftTokenId !== null && data.requiredNftContractAddress),
    {
      message: 'Contract address is required when specifying a token ID',
      path: ['requiredNftContractAddress'],
    }
  );

/**
 * DM chat creation schema
 */
export const DMChatCreateSchema = z.object({
  userId: UserIdSchema,
});

/**
 * Chat ID parameter schema
 */
export const ChatIdParamSchema = z.object({
  id: z.string().min(1),
});

/**
 * Chat query parameters schema
 */
export const ChatQuerySchema = z.object({
  all: z.enum(['true', 'false']).optional(),
  debug: z.enum(['true', 'false']).optional(),
});

/**
 * Chat message query schema
 */
export const ChatMessageQuerySchema = PaginationSchema.extend({
  chatId: z.string().min(1).optional(),
});

/**
 * Chat message response schema (for type safety)
 */
export const ChatMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  senderId: SnowflakeIdSchema,
  chatId: z.string(),
  createdAt: z.date(),
});

/**
 * Chat participant schema
 */
export const ChatParticipantSchema = z.object({
  id: SnowflakeIdSchema,
  displayName: z.string(),
  username: z.string().optional(),
  profileImageUrl: z.string().optional(),
});

/**
 * Chat response schema
 */
export const ChatSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  isGroup: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  participants: z.array(ChatParticipantSchema).optional(),
  lastMessage: ChatMessageSchema.optional(),
});
