import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestVault, type TestVault } from "@elizaos/vault";
import type { TeeBootGate } from "../services/tee-boot-gate.ts";
import {
  clearTeeBootGateState,
  setTeeBootGateState,
} from "../services/tee-boot-gate-state.ts";
import {
  bridgeAgentWalletsToProcessEnv,
  ensureAgentWallets,
  revealAgentWalletPrivateKey,
} from "./agent-wallets.ts";

const blockingGate: TeeBootGate = {
  policy: undefined,
  teeConfigured: true,
  required: true,
  productionProfile: false,
  secretsEnabled: false,
};

const AGENT_ID = "tee-gate-agent";

describe("agent-wallets TEE boot-gate enforcement", () => {
  let test: TestVault;

  beforeEach(async () => {
    clearTeeBootGateState();
    test = await createTestVault();
    await ensureAgentWallets(test.vault, AGENT_ID, "test");
  });

  afterEach(async () => {
    clearTeeBootGateState();
    delete process.env.ELIZA_AGENT_WALLET_AS_USER;
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    await test.dispose();
  });

  describe("revealAgentWalletPrivateKey", () => {
    it("reveals normally when no gate is set (inert default)", async () => {
      const pk = await revealAgentWalletPrivateKey(
        test.vault,
        AGENT_ID,
        "evm",
        "test",
      );
      expect(typeof pk).toBe("string");
      expect(pk.length).toBeGreaterThan(0);
    });

    it("refuses with a [TeeBootGate] error when the gate blocks", async () => {
      setTeeBootGateState(blockingGate);
      await expect(
        revealAgentWalletPrivateKey(test.vault, AGENT_ID, "evm", "test"),
      ).rejects.toThrow(/\[TeeBootGate\].*reveal blocked/);
    });
  });

  describe("bridgeAgentWalletsToProcessEnv", () => {
    it("bridges to process.env when opted in and no gate is set", async () => {
      process.env.ELIZA_AGENT_WALLET_AS_USER = "1";
      const descriptors = [
        {
          agentId: AGENT_ID,
          chain: "evm" as const,
          address: "0xabc",
          lastModified: Date.now(),
        },
      ];
      await bridgeAgentWalletsToProcessEnv(
        test.vault,
        AGENT_ID,
        descriptors,
        "test",
      );
      expect(process.env.EVM_PRIVATE_KEY?.length ?? 0).toBeGreaterThan(0);
    });

    it("skips the bridge (no env write) when the gate blocks", async () => {
      process.env.ELIZA_AGENT_WALLET_AS_USER = "1";
      setTeeBootGateState(blockingGate);
      const descriptors = [
        {
          agentId: AGENT_ID,
          chain: "evm" as const,
          address: "0xabc",
          lastModified: Date.now(),
        },
      ];
      await bridgeAgentWalletsToProcessEnv(
        test.vault,
        AGENT_ID,
        descriptors,
        "test",
      );
      expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    });
  });
});
