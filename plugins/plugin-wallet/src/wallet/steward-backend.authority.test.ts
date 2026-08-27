import { afterEach, describe, expect, it } from "vitest";
import { withProjectedStewardAuthority } from "./steward-backend.js";

const KEYS = [
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
] as const;
const saved = Object.fromEntries(
  KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Steward backend authority projection", () => {
  it("holds one exact tuple for the complete asynchronous operation", async () => {
    process.env.STEWARD_API_URL = "https://attacker.example/steward";
    process.env.STEWARD_TENANT_ID = "attacker";
    process.env.STEWARD_AGENT_ID = "attacker-agent";
    process.env.ELIZA_STEWARD_AGENT_ID = "attacker-agent";
    process.env.STEWARD_API_KEY = "attacker-key";
    process.env.STEWARD_AGENT_TOKEN = "attacker-token";

    await withProjectedStewardAuthority(
      {
        authority: "staging-explicit",
        enabled: true,
        apiUrl: "https://staging.eliza.app/steward",
        tenantId: "elizacloud-staging",
        agentId: "staging-agent",
        agentToken: "staging-token",
      },
      async () => {
        await Promise.resolve();
        expect(process.env).toMatchObject({
          STEWARD_API_URL: "https://staging.eliza.app/steward",
          STEWARD_TENANT_ID: "elizacloud-staging",
          STEWARD_AGENT_ID: "staging-agent",
          ELIZA_STEWARD_AGENT_ID: "staging-agent",
          STEWARD_AGENT_TOKEN: "staging-token",
        });
        expect(process.env.STEWARD_API_KEY).toBeUndefined();
      },
    );

    expect(process.env).toMatchObject({
      STEWARD_API_URL: "https://attacker.example/steward",
      STEWARD_TENANT_ID: "attacker",
      STEWARD_AGENT_ID: "attacker-agent",
      ELIZA_STEWARD_AGENT_ID: "attacker-agent",
      STEWARD_API_KEY: "attacker-key",
      STEWARD_AGENT_TOKEN: "attacker-token",
    });
  });

  it("restores the prior environment after a rejected operation", async () => {
    process.env.STEWARD_API_URL = "https://prior.example/steward";

    await expect(
      withProjectedStewardAuthority(
        {
          authority: "production",
          enabled: true,
          apiUrl: "https://eliza.app/steward",
          tenantId: "elizacloud",
          agentId: "production-agent",
          agentToken: "production-token",
        },
        async () => {
          throw new Error("expected failure");
        },
      ),
    ).rejects.toThrow("expected failure");

    expect(process.env.STEWARD_API_URL).toBe("https://prior.example/steward");
  });
});
