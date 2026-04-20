import { afterEach, describe, expect, it, vi } from "vitest";

describe("applySubscriptionCredentials", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS;
    delete process.env.OPENAI_API_KEY;
  });

  it("skips subscription credential mutation when disabled by env", async () => {
    process.env.ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS = "1";
    process.env.OPENAI_API_KEY = "original-openai-key";

    const { applySubscriptionCredentials } = await import("./credentials.js");

    await applySubscriptionCredentials({
      agents: { defaults: { model: { primary: "groq" } } },
    });

    expect(process.env.OPENAI_API_KEY).toBe("original-openai-key");
  });
});
