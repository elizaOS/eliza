import { z } from "zod";

/**
 * Caller-authored A2A conversation history. Authentication proves the caller's
 * identity, not authority to author system policy. A2A v0.3 calls the model
 * role `agent`; the legacy per-agent chat route used `assistant`, so both are
 * accepted at the wire boundary and normalized to the provider DTO.
 */
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
