import type { IAgentRuntime } from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEoaBackend } from "./local-eoa-backend.js";
import { resolveWalletBackend } from "./select-backend.js";
import { StewardBackend } from "./steward-backend.js";

const ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_WALLET_BACKEND",
  "ELIZA_WALLET_STEWARD_AUTO",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "STEWARD_AGENT_TOKEN",
] as const;
const saved = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function runtime(mode: "local" | "steward" | "auto"): IAgentRuntime {
  return {
    getSetting: (key: string) =>
      key === "ELIZA_WALLET_BACKEND" ? mode : undefined,
  } as unknown as IAgentRuntime;
}

describe("wallet backend development Cloud authority", () => {
  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    for (const key of ENV_KEYS) delete process.env[key];
    vi.spyOn(LocalEoaBackend, "create").mockResolvedValue({
      kind: "local",
    } as never);
    vi.spyOn(StewardBackend, "create").mockResolvedValue({
      kind: "steward",
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
  });

  it("does not let late auto flags activate Steward in staging-default", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZA_WALLET_STEWARD_AUTO = "1";
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_API_URL = "https://attacker.example/steward";
    process.env.STEWARD_AGENT_ID = "attacker-agent";
    process.env.STEWARD_AGENT_TOKEN = "attacker-token";

    await expect(resolveWalletBackend(runtime("auto"))).resolves.toMatchObject({
      kind: "local",
    });
    expect(StewardBackend.create).not.toHaveBeenCalled();
  });

  it("rejects an explicit Steward mode when the launcher blocked it", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "offline";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.STEWARD_AGENT_TOKEN = "late-attacker-token";

    await expect(resolveWalletBackend(runtime("steward"))).rejects.toThrow(
      /launcher did not authorize/i,
    );
    expect(StewardBackend.create).not.toHaveBeenCalled();
  });

  it("passes only the frozen explicit Steward tuple to the backend", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.STEWARD_API_URL = "https://staging.eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud-staging";
    process.env.STEWARD_AGENT_ID = "staging-agent";
    process.env.STEWARD_AGENT_TOKEN = "staging-token";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.STEWARD_API_URL = "https://attacker.example/steward";
    process.env.STEWARD_TENANT_ID = "attacker";
    process.env.STEWARD_AGENT_ID = "attacker-agent";
    process.env.STEWARD_AGENT_TOKEN = "attacker-token";

    await expect(
      resolveWalletBackend(runtime("steward")),
    ).resolves.toMatchObject({
      kind: "steward",
    });
    expect(StewardBackend.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        authority: "staging-explicit",
        enabled: true,
        apiUrl: "https://staging.eliza.app/steward",
        tenantId: "elizacloud-staging",
        agentId: "staging-agent",
        agentToken: "staging-token",
      }),
    );
  });
});
