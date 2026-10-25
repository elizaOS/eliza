/**
 * Validates caller-authored A2A conversation history before provider dispatch.
 * Authentication identifies a caller but does not grant authority to add model
 * policy, tool output, or provider-specific roles.
 */
import { z } from "zod";

export const UntrustedA2AChatMessageSchema = z
  .object({
    role: z
      .enum(["user", "assistant", "agent"])
      .transform((role) => (role === "agent" ? "assistant" : role)),
    content: z.string().min(1),
  })
  .strict();

export const UntrustedA2AChatMessagesSchema = z.array(UntrustedA2AChatMessageSchema).min(1);

export type UntrustedA2AChatMessage = z.output<typeof UntrustedA2AChatMessageSchema>;

export function parseUntrustedA2AChatMessages(value: unknown): UntrustedA2AChatMessage[] {
  return UntrustedA2AChatMessagesSchema.parse(value);
}
