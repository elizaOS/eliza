import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempElizaHome: string | null = null;

function writeSubscriptionCredentials(provider: "openai-codex"): void {
  if (!tempElizaHome) {
    tempElizaHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-"));
    process.env.ELIZA_HOME = tempElizaHome;
  }

  const authDir = path.join(tempElizaHome, "auth", provider);
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, "default.json"),
    JSON.stringify({
      id: "default",
      providerId: provider,
      label: "Default",
      source: "oauth",
      credentials: {
        access: "codex-subscription-token",
        refresh: "refresh-token",
        expires: Date.now() + 10 * 60_000,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("Codex CLI ~/.codex/auth.json", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-codex-cli-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    } else {
      delete process.env.HOME;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
  });

  it("surfaces codex-cli subscription status when auth uses tokens.access_token", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".codex", "auth.json"),
      JSON.stringify({
        tokens: { access_token: "oauth-access-token" },
      }),
    );

    const { getSubscriptionStatus } = await import("./credentials.js");
    const rows = getSubscriptionStatus();
    expect(
      rows.some(
        (r) =>
          r.provider === "openai-codex" &&
          r.accountId === "codex-cli" &&
          r.source === "codex-cli",
      ),
    ).toBe(true);
  });

  it("applySubscriptionCredentials reads OAuth access token when no eliza codex account exists", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".codex", "auth.json"),
      JSON.stringify({
        tokens: { access_token: "cli-oauth-token" },
      }),
    );

    const { applySubscriptionCredentials } = await import("./credentials.js");
    await applySubscriptionCredentials({
      agents: { defaults: { model: { primary: "gpt-4o" } } },
    });

    expect(process.env.OPENAI_API_KEY).toBe("cli-oauth-token");
  });

  it("surfaces codex-cli row for legacy OPENAI_API_KEY + non-api-key auth_mode", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".codex", "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: "legacy-subscription-token",
        auth_mode: "oauth",
      }),
    );

    const { getSubscriptionStatus } = await import("./credentials.js");
    const rows = getSubscriptionStatus();
    expect(
      rows.some(
        (r) =>
          r.provider === "openai-codex" &&
          r.accountId === "codex-cli" &&
          r.source === "codex-cli",
      ),
    ).toBe(true);
  });

  it("does not emit codex-cli row when Codex CLI is in api-key mode", async () => {
    fs.writeFileSync(
      path.join(tmpHome, ".codex", "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: "sk-openai-api-key",
        auth_mode: "api-key",
      }),
    );

    const { getSubscriptionStatus } = await import("./credentials.js");
    const rows = getSubscriptionStatus();
    expect(rows.some((r) => r.source === "codex-cli")).toBe(false);
  });
});

describe("applySubscriptionCredentials", () => {
  afterEach(() => {
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
  }, 300_000);

  it("injects Codex runtime credentials ahead of cloud inference", async () => {
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

    expect(process.env.OPENAI_API_KEY).toBe("codex-subscription-token");
    expect(config.agents.defaults.model?.primary).toBe("openai");
  });
});
