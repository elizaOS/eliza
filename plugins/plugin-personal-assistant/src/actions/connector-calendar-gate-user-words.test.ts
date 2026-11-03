import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { connectorAction } from "./connector";

const runtime = {} as unknown as IAgentRuntime;

function message(text: string): Memory {
  return {
    entityId: "owner-1",
    roomId: "room-1",
    content: { text },
  } as unknown as Memory;
}

describe("CONNECTOR calendar-feed gate reads user words", () => {
  it("does not exclude a Gmail connect ask whose documents mention a calendar feed", async () => {
    const augmented =
      "Answer the user request using the contextual documents\n" +
      "<contextual_documents>To connect google calendar, open settings.</contextual_documents>\n" +
      "<user_request>Connect my Gmail account.</user_request>";
    await expect(
      connectorAction.validate(runtime, message(augmented)),
    ).resolves.toBe(true);
  });

  it("still excludes a genuine calendar-feed connect ask wrapped in the envelope", async () => {
    const augmented =
      "Answer the user request using the contextual documents\n" +
      "<contextual_documents>Gmail settings help.</contextual_documents>\n" +
      "<user_request>Connect google calendar.</user_request>";
    await expect(
      connectorAction.validate(runtime, message(augmented)),
    ).resolves.toBe(false);
  });

  it("still excludes a plain calendar-feed connect ask", async () => {
    await expect(
      connectorAction.validate(runtime, message("Connect google calendar.")),
    ).resolves.toBe(false);
  });

  it("accepts a plain non-calendar connect ask", async () => {
    await expect(
      connectorAction.validate(runtime, message("Connect my Gmail account.")),
    ).resolves.toBe(true);
  });
});
