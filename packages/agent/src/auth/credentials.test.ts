import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let tempElizaHome: string | null = null;

function writeSubscriptionCredentials(provider: "openai-codex"): void {
  if (!tempElizaHome) {
    tempElizaHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-"));
    process.env.ELIZA_HOME = tempElizaHome;
  }

  const authDir = path.join(tempElizaHome, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, `${provider}.json`),
    JSON.stringify({
      provider,
      credentials: {
        access: "codex-subscription-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("applySubscriptionCredentials", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELIZA_HOME;
    if (tempElizaHome) {
      fs.rmSync(tempElizaHome, { recursive: true, force: true });
      tempElizaHome = null;
    }
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

  it("does not inject Codex runtime credentials when cloud inference is active", async () => {
    writeSubscriptionCredentials("openai-codex");

    const { applySubscriptionCredentials } = await import("./credentials.js");
    const config = {
      agents: {
        defaults: {
          subscriptionProvider: "openai-codex",
        },
      },
      serviceRouting: {
        llmText: {
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
    };

    await applySubscriptionCredentials(config);

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(config.agents.defaults.model?.primary).toBeUndefined();
  });
});
