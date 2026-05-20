/**
 * Message types for chat and notifications.
 * Client-safe enum and union used across web and services.
 *
 * Note: This type must stay in sync with the database enum defined in
 * `packages/db/src/schema/messaging.ts` (`messageTypeEnum` pgEnum).
 * If new message types are added to the database, update this definition accordingly.
 */

export const MessageTypeEnum = {
  USER: "user",
  SYSTEM: "system",
  COORDINATOR: "coordinator",
} as const;

export type MessageType =
  (typeof MessageTypeEnum)[keyof typeof MessageTypeEnum];
