import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWalletAddresses,
  getWalletAddressesWithSteward,
  initStewardWalletCache,
} from "./wallet.ts";

const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_EVM_ADDRESS",
  "STEWARD_SOLANA_ADDRESS",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "WALLET_SOURCE_EVM",
  "WALLET_SOURCE_SOLANA",
] as const;

describe("agent Steward wallet authority", () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;
  let stateDir: string;

  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    saved = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
    for (const key of ENV_KEYS) delete process.env[key];
    stateDir = mkdtempSync(path.join(os.tmpdir(), "eliza-steward-authority-"));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
    rmSync(stateDir, { force: true, recursive: true });
  });

  it("ignores persisted production credentials and stale addresses under default staging", async () => {
    writeFileSync(
      path.join(stateDir, "steward-credentials.json"),
      JSON.stringify({
        apiUrl: "https://eliza.app/steward",
        tenantId: "elizacloud",
        agentId: "production-agent",
        apiKey: "production-key",
        agentToken: "production-token",
      }),
    );
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    captureDevCloudEnvAuthoritySnapshot();
    process.env.STEWARD_EVM_ADDRESS =
      "0x1111111111111111111111111111111111111111";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await initStewardWalletCache();
    await getWalletAddressesWithSteward();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
  });

  it("does not let late URL and token pollution complete an insufficient explicit tuple", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.STEWARD_API_URL = "https://staging.eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud-staging";
    process.env.STEWARD_AGENT_ID = "staging-agent";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.STEWARD_API_URL = "https://eliza.app/steward";
    process.env.STEWARD_AGENT_TOKEN = "late-production-token";
    process.env.STEWARD_API_KEY = "late-production-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await initStewardWalletCache();
    await getWalletAddressesWithSteward();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a complete explicit tuple on its frozen URL and credentials", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.STEWARD_API_URL = "https://staging.eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud-staging";
    process.env.STEWARD_AGENT_ID = "staging-agent";
    process.env.STEWARD_AGENT_TOKEN = "staging-token";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.STEWARD_API_URL = "https://eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud";
    process.env.STEWARD_AGENT_ID = "production-agent";
    process.env.STEWARD_AGENT_TOKEN = "production-token";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ walletAddresses: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await initStewardWalletCache();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://staging.eliza.app/steward/agents/staging-agent",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer staging-token",
      "X-Steward-Tenant": "elizacloud-staging",
    });
  });
});
