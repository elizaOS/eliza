/**
 * Public agent-wallet address caching is tested without exposing vault-backed
 * private keys or replacing explicit operator-selected wallet sources.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentWalletAddressCacheSession,
  abandonAgentWalletAddressCacheSession,
  activateAgentWalletAddressCacheSession,
  beginAgentWalletAddressCacheSession,
  beginDeferredAgentWalletAddressCacheSession,
  CLOUD_EVM_ADDRESS_ENV_KEY,
  cacheAgentWalletAddresses,
  getWalletAddresses,
  WALLET_SOURCE_EVM_ENV_KEY,
} from "./wallet.ts";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const CLOUD_EVM_ADDRESS = "0x2222222222222222222222222222222222222222";
const SOLANA_ADDRESS = "So11111111111111111111111111111111111111112";
const SECOND_EVM_ADDRESS = "0x3333333333333333333333333333333333333333";
const SECOND_SOLANA_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const AGENT_A = "00000000-0000-0000-0000-0000000000aa";
const AGENT_B = "00000000-0000-0000-0000-0000000000bb";

const ENV_KEYS = [
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "STEWARD_EVM_ADDRESS",
  "STEWARD_SOLANA_ADDRESS",
  "ELIZA_MANAGED_EVM_ADDRESS",
  "ELIZA_MANAGED_SOLANA_ADDRESS",
  CLOUD_EVM_ADDRESS_ENV_KEY,
  "ELIZA_CLOUD_SOLANA_ADDRESS",
  WALLET_SOURCE_EVM_ENV_KEY,
  "WALLET_SOURCE_SOLANA",
] as const;

let originalEnv: Record<string, string | undefined>;
let agentASession: AgentWalletAddressCacheSession;
let agentBSession: AgentWalletAddressCacheSession;

beforeEach(() => {
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of ENV_KEYS) delete process.env[key];
  agentASession = beginAgentWalletAddressCacheSession(AGENT_A);
  agentBSession = beginAgentWalletAddressCacheSession(AGENT_B);
});

afterEach(() => {
  beginAgentWalletAddressCacheSession(AGENT_A);
  beginAgentWalletAddressCacheSession(AGENT_B);
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agent wallet public-address cache", () => {
  it("makes both vault-backed public identities available without env keys", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });

    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
  });

  it("starts a cold runtime session empty without affecting another agent", () => {
    expect(
      cacheAgentWalletAddresses(agentASession, {
        evmAddress: EVM_ADDRESS,
        solanaAddress: SOLANA_ADDRESS,
      }),
    ).toBe(true);
    expect(
      cacheAgentWalletAddresses(agentBSession, {
        evmAddress: SECOND_EVM_ADDRESS,
        solanaAddress: SECOND_SOLANA_ADDRESS,
      }),
    ).toBe(true);

    agentASession = beginAgentWalletAddressCacheSession(AGENT_A);

    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    expect(getWalletAddresses(AGENT_B)).toEqual({
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });
  });

  it("keeps incumbent addresses visible while a replacement session builds", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });

    beginDeferredAgentWalletAddressCacheSession(AGENT_A);

    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
  });

  it("preserves the incumbent cache and session when a replacement is abandoned", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    const replacementSession =
      beginDeferredAgentWalletAddressCacheSession(AGENT_A);
    cacheAgentWalletAddresses(replacementSession, {
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });

    expect(abandonAgentWalletAddressCacheSession(replacementSession)).toBe(
      true,
    );
    expect(
      cacheAgentWalletAddresses(replacementSession, {
        evmAddress: SECOND_EVM_ADDRESS,
        solanaAddress: SECOND_SOLANA_ADDRESS,
      }),
    ).toBe(false);
    expect(activateAgentWalletAddressCacheSession(replacementSession)).toBe(
      false,
    );
    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    expect(
      cacheAgentWalletAddresses(agentASession, {
        evmAddress: EVM_ADDRESS,
        solanaAddress: null,
      }),
    ).toBe(true);
    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: null,
    });
  });

  it("clears incumbent addresses when an empty replacement activates", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    const replacementSession =
      beginDeferredAgentWalletAddressCacheSession(AGENT_A);

    expect(activateAgentWalletAddressCacheSession(replacementSession)).toBe(
      true,
    );
    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    expect(
      cacheAgentWalletAddresses(agentASession, {
        evmAddress: EVM_ADDRESS,
        solanaAddress: SOLANA_ADDRESS,
      }),
    ).toBe(false);
  });

  it("promotes staged replacement addresses only when the session activates", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    const replacementSession =
      beginDeferredAgentWalletAddressCacheSession(AGENT_A);
    expect(
      cacheAgentWalletAddresses(replacementSession, {
        evmAddress: SECOND_EVM_ADDRESS,
        solanaAddress: SECOND_SOLANA_ADDRESS,
      }),
    ).toBe(true);
    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });

    expect(activateAgentWalletAddressCacheSession(replacementSession)).toBe(
      true,
    );
    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });
  });

  it("accepts replacement publication that completes after activation", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    const replacementSession =
      beginDeferredAgentWalletAddressCacheSession(AGENT_A);

    expect(activateAgentWalletAddressCacheSession(replacementSession)).toBe(
      true,
    );
    expect(
      cacheAgentWalletAddresses(replacementSession, {
        evmAddress: SECOND_EVM_ADDRESS,
        solanaAddress: SECOND_SOLANA_ADDRESS,
      }),
    ).toBe(true);
    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });
  });

  it("isolates cached public identities between two agents", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    cacheAgentWalletAddresses(agentBSession, {
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });

    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    expect(getWalletAddresses(AGENT_B)).toEqual({
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });
    expect(getWalletAddresses("unknown-agent")).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    expect(getWalletAddresses()).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
  });

  it("clears only the requested agent's cached identities", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    cacheAgentWalletAddresses(agentBSession, {
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });

    cacheAgentWalletAddresses(agentASession, {
      evmAddress: null,
      solanaAddress: null,
    });

    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: null,
      solanaAddress: null,
    });
    expect(getWalletAddresses(AGENT_B)).toEqual({
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });
  });

  it("keeps an explicit cloud source authoritative", () => {
    cacheAgentWalletAddresses(agentASession, {
      evmAddress: EVM_ADDRESS,
      solanaAddress: SOLANA_ADDRESS,
    });
    process.env[WALLET_SOURCE_EVM_ENV_KEY] = "cloud";
    process.env[CLOUD_EVM_ADDRESS_ENV_KEY] = CLOUD_EVM_ADDRESS;

    expect(getWalletAddresses(AGENT_A).evmAddress).toBe(CLOUD_EVM_ADDRESS);
  });

  it("rejects malformed public identities", () => {
    expect(() =>
      cacheAgentWalletAddresses(agentASession, {
        evmAddress: "not-an-address",
        solanaAddress: null,
      }),
    ).toThrow(TypeError);
  });

  it("rejects publication and activation from a superseded pending session", async () => {
    const supersededSession =
      beginDeferredAgentWalletAddressCacheSession(AGENT_A);
    const deferredPublication = Promise.resolve().then(() =>
      cacheAgentWalletAddresses(supersededSession, {
        evmAddress: EVM_ADDRESS,
        solanaAddress: SOLANA_ADDRESS,
      }),
    );
    const replacementSession =
      beginDeferredAgentWalletAddressCacheSession(AGENT_A);
    expect(
      cacheAgentWalletAddresses(replacementSession, {
        evmAddress: SECOND_EVM_ADDRESS,
        solanaAddress: SECOND_SOLANA_ADDRESS,
      }),
    ).toBe(true);

    expect(await deferredPublication).toBe(false);
    expect(activateAgentWalletAddressCacheSession(supersededSession)).toBe(
      false,
    );
    expect(activateAgentWalletAddressCacheSession(replacementSession)).toBe(
      true,
    );
    expect(getWalletAddresses(AGENT_A)).toEqual({
      evmAddress: SECOND_EVM_ADDRESS,
      solanaAddress: SECOND_SOLANA_ADDRESS,
    });
  });

  it("rejects an unscoped cache session", () => {
    expect(() => beginAgentWalletAddressCacheSession("  ")).toThrow(
      "agent id is required to start an address cache session",
    );
  });
});
