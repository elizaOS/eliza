import { describe, expect, it } from "vitest";
import { ensureCanonicalSecretNamesInReply } from "../src/handlers/harness-bridge.js";

describe("harness bridge helpers", () => {
  it("adds canonical secret key names to successful storage replies", () => {
    const decision = ensureCanonicalSecretNamesInReply({
      replyText: "Your OpenAI API key has been set.",
      setSecrets: { OPENAI_API_KEY: "sk-test" },
      deleteSecrets: [],
      refusedInPublic: false,
    });

    expect(decision.replyText).toContain("OPENAI_API_KEY");
    expect(decision.replyText).not.toContain("sk-test");
  });

  it("leaves already canonical replies unchanged", () => {
    const decision = ensureCanonicalSecretNamesInReply({
      replyText: "OPENAI_API_KEY set.",
      setSecrets: { OPENAI_API_KEY: "sk-test" },
      deleteSecrets: [],
      refusedInPublic: false,
    });

    expect(decision.replyText).toBe("OPENAI_API_KEY set.");
  });
});
