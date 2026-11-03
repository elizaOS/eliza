import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { resolveReferentAction } from "./resolve-referent";

const runtime = {} as unknown as IAgentRuntime;

function message(text: string): Memory {
  return {
    entityId: "owner-1",
    roomId: "room-1",
    content: { text },
  } as unknown as Memory;
}

describe("RESOLVE_REFERENT validate reads user words", () => {
  it("does not treat a marker phrase inside contextual documents as an implicit ask", async () => {
    const augmented =
      "Answer the user request using the contextual documents\n" +
      "<contextual_documents>Note: do it the same as last time.</contextual_documents>\n" +
      "<user_request>Book a flight to Seoul on Friday at 9am.</user_request>";
    await expect(
      resolveReferentAction.validate(runtime, message(augmented)),
    ).resolves.toBe(false);
  });

  it("still recognises a genuinely implicit ask wrapped in the envelope", async () => {
    const augmented =
      "Answer the user request using the contextual documents\n" +
      "<contextual_documents>Flight options for Seoul.</contextual_documents>\n" +
      "<user_request>Book the usual.</user_request>";
    await expect(
      resolveReferentAction.validate(runtime, message(augmented)),
    ).resolves.toBe(true);
  });

  it("still recognises a plain implicit ask", async () => {
    await expect(
      resolveReferentAction.validate(runtime, message("Book the usual.")),
    ).resolves.toBe(true);
  });

  it("rejects a plain fully-specified ask", async () => {
    await expect(
      resolveReferentAction.validate(
        runtime,
        message("Book a flight to Seoul on Friday at 9am."),
      ),
    ).resolves.toBe(false);
  });
});
