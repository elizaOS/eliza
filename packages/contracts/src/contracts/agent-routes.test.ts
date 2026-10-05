/** Keeps encrypted agent exports inside the password envelope accepted by the
 * matching import route, including passwords whose UTF-8 size exceeds their
 * JavaScript string length. */

import { describe, expect, it } from "vitest";
import {
  AGENT_TRANSFER_MAX_PASSWORD_BYTES,
  agentTransferPasswordByteLength,
  PostAgentExportRequestSchema,
} from "./agent-routes.ts";

function parsePassword(password: string) {
  return PostAgentExportRequestSchema.safeParse({ password });
}

describe("agent transfer password envelope", () => {
  it("accepts passwords at the import byte limit", () => {
    const password = "x".repeat(AGENT_TRANSFER_MAX_PASSWORD_BYTES);

    expect(agentTransferPasswordByteLength(password)).toBe(
      AGENT_TRANSFER_MAX_PASSWORD_BYTES,
    );
    expect(parsePassword(password).success).toBe(true);
  });

  it("rejects exports whose password cannot fit the import envelope", () => {
    const ascii = "x".repeat(AGENT_TRANSFER_MAX_PASSWORD_BYTES + 1);
    const multibyte = "密".repeat(342);

    expect(agentTransferPasswordByteLength(multibyte)).toBe(1026);
    for (const password of [ascii, multibyte]) {
      const parsed = parsePassword(password);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe(
          `Password must be at most ${AGENT_TRANSFER_MAX_PASSWORD_BYTES} bytes when UTF-8 encoded.`,
        );
      }
    }
  });
});
