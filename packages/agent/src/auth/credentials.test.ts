import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAccount } from "./account-storage";
import {
  applySubscriptionCredentials,
  deleteProviderCredentials,
  getAccessToken,
  getSubscriptionStatus,
  listProviderAccounts,
  saveCredentials,
} from "./credentials";

const tempHomes: string[] = [];

function useTempElizaHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-auth-test-"));
  tempHomes.push(dir);
  vi.stubEnv("ELIZA_HOME", dir);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  return dir;
}

describe("applySubscriptionCredentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempHomes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose Codex subscription credentials as OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const config: Parameters<typeof applySubscriptionCredentials>[0] = {
      agents: {
        defaults: {
          subscriptionProvider: "openai-codex",
        },
      },
    };

    await applySubscriptionCredentials(config);

    expect(process.env.OPENAI_API_KEY).toBe("");
    expect(config.agents?.defaults?.model?.primary).toBe("codex-cli");
  });

  it("leaves a direct OpenAI API key untouched", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-direct-openai-key");
    const config: Parameters<typeof applySubscriptionCredentials>[0] = {
      agents: {
        defaults: {
          subscriptionProvider: "openai-codex",
        },
      },
    };

    await applySubscriptionCredentials(config);

    expect(process.env.OPENAI_API_KEY).toBe("sk-direct-openai-key");
    expect(config.agents?.defaults?.model?.primary).toBe("codex-cli");
  });

  it("stores, resolves, reports, and deletes multiple accounts per provider", async () => {
    useTempElizaHome();
    const expires = Date.now() + 60 * 60_000;

    saveCredentials(
      "openai-codex",
      { access: "access-personal", refresh: "refresh-personal", expires },
      "personal",
    );
    saveCredentials(
      "openai-codex",
      { access: "access-work", refresh: "refresh-work", expires },
      "work",
    );

    const accountIds = listProviderAccounts("openai-codex")
      .map((account) => account.id)
      .sort();
    expect(accountIds).toEqual(["personal", "work"]);
    await expect(getAccessToken("openai-codex", "personal")).resolves.toBe(
      "access-personal",
    );
    await expect(getAccessToken("openai-codex", "work")).resolves.toBe(
      "access-work",
    );

    const statusRows = getSubscriptionStatus()
      .filter((row) => row.provider === "openai-codex" && row.configured)
      .map((row) => row.accountId)
      .sort();
    expect(statusRows).toEqual(["personal", "work"]);

    expect(deleteProviderCredentials("openai-codex")).toBe(2);
    expect(listProviderAccounts("openai-codex")).toHaveLength(0);
  });

  it("stores multiple z.ai coding-plan accounts without exposing them as direct API keys", async () => {
    useTempElizaHome();
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("Z_AI_API_KEY", "");
    const now = Date.now();
    const expires = Number.MAX_SAFE_INTEGER;

    saveAccount({
      id: "personal",
      providerId: "zai-coding",
      label: "Personal",
      source: "api-key",
      credentials: {
        access: "zai-coding-personal",
        refresh: "",
        expires,
      },
      createdAt: now,
      updatedAt: now,
    });
    saveAccount({
      id: "work",
      providerId: "zai-coding",
      label: "Work",
      source: "api-key",
      credentials: {
        access: "zai-coding-work",
        refresh: "",
        expires,
      },
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    const accountIds = listProviderAccounts("zai-coding")
      .map((account) => account.id)
      .sort();
    expect(accountIds).toEqual(["personal", "work"]);
    await expect(getAccessToken("zai-coding", "personal")).resolves.toBe(
      "zai-coding-personal",
    );
    await expect(getAccessToken("zai-coding", "work")).resolves.toBe(
      "zai-coding-work",
    );

    const statusRows = getSubscriptionStatus().filter(
      (row) => row.provider === "zai-coding" && row.configured,
    );
    expect(statusRows.map((row) => row.accountId).sort()).toEqual([
      "personal",
      "work",
    ]);
    expect(new Set(statusRows.map((row) => row.source))).toEqual(
      new Set(["coding-plan-key"]),
    );

    const config: Parameters<typeof applySubscriptionCredentials>[0] = {
      agents: {
        defaults: {
          subscriptionProvider: "zai-coding",
        },
      },
    };
    await applySubscriptionCredentials(config);

    expect(process.env.ZAI_API_KEY).toBe("");
    expect(process.env.Z_AI_API_KEY).toBe("");
    expect(config.agents?.defaults?.model?.primary).toBeUndefined();
  });
});
