/**
 * Opt-in live contract test that opens a real public Aomi thread and completes a walletless request.
 */
import { Session } from "@aomi-labs/client";
import { describe, expect, it } from "vitest";

const live = process.env.ELIZA_E2E_AOMI === "1";

describe.runIf(live)("Aomi live client contract", () => {
  it("completes a public read-only request", async () => {
    const session = new Session(
      {
        baseUrl: process.env.AOMI_API_URL ?? "https://api.aomi.dev",
        apiKey: process.env.AOMI_API_KEY,
      },
      {
        app: process.env.AOMI_APP ?? "default",
        clientType: "elizaos-e2e",
      },
    );
    try {
      const result = await session.send(
        "Reply with a one-sentence description of Aomi. Do not create or request a transaction.",
      );
      expect(
        result.messages.some(
          (message) =>
            message.sender === "agent" &&
            typeof message.content === "string" &&
            message.content.trim().length > 0,
        ),
      ).toBe(true);
      expect(session.getPendingRequests()).toHaveLength(0);
    } finally {
      session.close();
    }
  }, 120_000);
});
