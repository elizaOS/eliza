/**
 * Replacement-runtime wallet cache ownership is exercised through the real
 * construction boundary. The build is deterministically aborted before
 * initialization, with no vault, chain, API server, or model traffic.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringToUuid } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginAgentWalletAddressCacheSession,
  cacheAgentWalletAddresses,
  getWalletAddresses,
} from "../api/wallet.ts";
import { buildInitializedRuntime } from "./eliza.ts";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOLANA_ADDRESS = "So11111111111111111111111111111111111111112";
const REPLACEMENT_NAME = "Wallet Cache Replacement Test";
const AGENT_ID = stringToUuid(REPLACEMENT_NAME);
const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_DISABLE_VAULT_PROFILE_RESOLVER",
  "ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
let stateDirectory: string | null = null;

afterEach(async () => {
  beginAgentWalletAddressCacheSession(AGENT_ID);
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (stateDirectory) {
    await fs.rm(stateDirectory, { recursive: true, force: true });
    stateDirectory = null;
  }
});

describe("replacement runtime wallet-address cache lifecycle", () => {
  it("preserves the incumbent through construction and failed replacement", async () => {
    stateDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-wallet-cache-replacement-"),
    );
    process.env.ELIZA_STATE_DIR = stateDirectory;
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
    process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP = "1";

    const incumbentSession = beginAgentWalletAddressCacheSession(AGENT_ID);
    cacheAgentWalletAddresses(incumbentSession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    const abortController = new AbortController();

    await expect(
      buildInitializedRuntime({
        abortSignal: abortController.signal,
        config: {
          firstRun: false,
          ui: { assistant: { name: REPLACEMENT_NAME } },
          agents: {
            defaults: {
              workspace: path.join(stateDirectory, "workspace"),
            },
          },
        } as never,
        onRuntimeCreated: (runtime) => {
          expect(runtime.agentId).toBe(AGENT_ID);
          expect(getWalletAddresses(AGENT_ID)).toEqual({
            evmAddress: EVM_ADDRESS,
            solanaAddress: SOLANA_ADDRESS,
          });
          abortController.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(getWalletAddresses(AGENT_ID)).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    expect(
      cacheAgentWalletAddresses(incumbentSession, {
        evmAddress: EVM_ADDRESS,
        solanaAddress: null,
      }),
    ).toBe(true);
  });
});
