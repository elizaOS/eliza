import { createTestVault, type TestVault } from "@elizaos/vault/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __test__,
  ensureAgentWallets,
  generateAgentWallet,
  getAgentWalletDescriptor,
  hasAgentWallet,
  listAgentsWithWallets,
  listAgentWallets,
  removeAgentWallet,
  removeAllAgentWallets,
  revealAgentWalletPrivateKey,
  setAgentWallet,
} from "./agent-wallets.js";

describe("agent-wallets", () => {
  let testVault: TestVault;

  beforeEach(async () => {
    testVault = await createTestVault();
  });

  afterEach(async () => {
    await testVault.dispose();
  });

  describe("key shape", () => {
    test("walletKey encodes agentId segments safely", () => {
      expect(__test__.walletKey("alice", "evm")).toBe("agent.alice.wallet.evm");
      // Dots in agent IDs would break vault prefix matching otherwise
      expect(__test__.walletKey("alice.bob", "evm")).toBe(
        "agent.alice.bob.wallet.evm".replace("alice.bob", "alice%2Ebob"),
      );
    });

    test("parseAgentWalletKey round-trips", () => {
      const key = __test__.walletKey("alice", "solana");
      expect(__test__.parseAgentWalletKey(key)).toEqual({
        agentId: "alice",
        chain: "solana",
      });
    });

    test("parseAgentWalletKey rejects malformed keys", () => {
      expect(__test__.parseAgentWalletKey("agent.alice.wallet")).toBeNull();
      expect(__test__.parseAgentWalletKey("creds.alice.wallet.evm")).toBeNull();
      expect(__test__.parseAgentWalletKey("agent.alice.wallet.btc")).toBeNull();
    });

    test("agent IDs with special characters round-trip", () => {
      const id = "agent/with:weird.chars";
      const key = __test__.walletKey(id, "evm");
      const parsed = __test__.parseAgentWalletKey(key);
      expect(parsed?.agentId).toBe(id);
    });
  });

  describe("generateAgentWallet", () => {
    test("creates an EVM wallet and persists it sensitively", async () => {
      const desc = await generateAgentWallet(testVault.vault, "alice", "evm");
      expect(desc.agentId).toBe("alice");
      expect(desc.chain).toBe("evm");
      expect(desc.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const stored = await testVault.vault.describe(
        __test__.walletKey("alice", "evm"),
      );
      expect(stored?.sensitive).toBe(true);
      expect(stored?.source).toBe("keychain-encrypted");
    });

    test("creates a Solana wallet and persists it sensitively", async () => {
      const desc = await generateAgentWallet(
        testVault.vault,
        "alice",
        "solana",
      );
      expect(desc.chain).toBe("solana");
      // Solana base58 addresses are 32-44 chars
      expect(desc.address.length).toBeGreaterThanOrEqual(32);
      expect(desc.address.length).toBeLessThanOrEqual(44);
    });

    test("two calls for the same agent+chain replace the wallet", async () => {
      const first = await generateAgentWallet(testVault.vault, "alice", "evm");
      const second = await generateAgentWallet(testVault.vault, "alice", "evm");
      expect(second.address).not.toBe(first.address);
    });

    test("different agents get different wallets", async () => {
      const a = await generateAgentWallet(testVault.vault, "alice", "evm");
      const b = await generateAgentWallet(testVault.vault, "bob", "evm");
      expect(a.address).not.toBe(b.address);
    });
  });

  describe("hasAgentWallet / getAgentWalletDescriptor", () => {
    test("returns false / null when missing", async () => {
      expect(await hasAgentWallet(testVault.vault, "alice", "evm")).toBe(false);
      expect(
        await getAgentWalletDescriptor(testVault.vault, "alice", "evm"),
      ).toBeNull();
    });

    test("returns descriptor without revealing the private key", async () => {
      const created = await generateAgentWallet(
        testVault.vault,
        "alice",
        "evm",
      );
      const desc = await getAgentWalletDescriptor(
        testVault.vault,
        "alice",
        "evm",
      );
      expect(desc?.address).toBe(created.address);
      // descriptor type has no privateKey field — ensure shape
      expect(Object.keys(desc ?? {})).toEqual(
        expect.arrayContaining(["agentId", "chain", "address", "lastModified"]),
      );
      expect(Object.keys(desc ?? {})).not.toContain("privateKey");
    });
  });

  describe("revealAgentWalletPrivateKey", () => {
    test("returns the original private key", async () => {
      const created = await generateAgentWallet(
        testVault.vault,
        "alice",
        "evm",
      );
      const pk = await revealAgentWalletPrivateKey(
        testVault.vault,
        "alice",
        "evm",
        "test-caller",
      );
      // EVM private key is 0x + 64 hex chars
      expect(pk).toMatch(/^0x[0-9a-fA-F]{64}$/);
      // Sanity: re-deriving from the revealed key matches stored address
      expect(__test__.deriveAddressFor("evm", pk)).toBe(created.address);
    });

    test("audit log records the reveal with caller", async () => {
      await generateAgentWallet(testVault.vault, "alice", "evm");
      await testVault.clearAuditLog();
      await revealAgentWalletPrivateKey(
        testVault.vault,
        "alice",
        "evm",
        "BROWSER_AUTOFILL_LOGIN",
      );
      const records = await testVault.getAuditRecords();
      const reveal = records.find((r) => r.action === "reveal");
      expect(reveal).toBeDefined();
      expect(reveal?.caller).toBe("BROWSER_AUTOFILL_LOGIN");
      expect(reveal?.key).toBe(__test__.walletKey("alice", "evm"));
    });
  });

  describe("listAgentWallets / listAgentsWithWallets", () => {
    test("listAgentWallets returns both chains for one agent", async () => {
      await generateAgentWallet(testVault.vault, "alice", "evm");
      await generateAgentWallet(testVault.vault, "alice", "solana");
      const wallets = await listAgentWallets(testVault.vault, "alice");
      expect(wallets.map((w) => w.chain).sort()).toEqual(["evm", "solana"]);
    });

    test("listAgentWallets is scoped to one agent", async () => {
      await generateAgentWallet(testVault.vault, "alice", "evm");
      await generateAgentWallet(testVault.vault, "bob", "evm");
      const wallets = await listAgentWallets(testVault.vault, "alice");
      expect(wallets).toHaveLength(1);
      expect(wallets[0]?.agentId).toBe("alice");
    });

    test("listAgentsWithWallets enumerates distinct agent IDs", async () => {
      await generateAgentWallet(testVault.vault, "alice", "evm");
      await generateAgentWallet(testVault.vault, "alice", "solana");
      await generateAgentWallet(testVault.vault, "bob", "evm");
      const agents = await listAgentsWithWallets(testVault.vault);
      expect(agents.sort()).toEqual(["alice", "bob"]);
    });

    test("listAgentsWithWallets does not collide with non-wallet agent.* keys", async () => {
      await generateAgentWallet(testVault.vault, "alice", "evm");
      // Some other consumer scribbling in the agent.* namespace shouldn't
      // surface as a wallet-bearing agent.
      await testVault.vault.set("agent.alice.preferences.theme", "dark");
      await testVault.vault.set("agent.bob.preferences.theme", "light");
      const agents = await listAgentsWithWallets(testVault.vault);
      expect(agents).toEqual(["alice"]);
    });
  });

  describe("ensureAgentWallets", () => {
    test("generates both chains when nothing exists", async () => {
      const result = await ensureAgentWallets(testVault.vault, "alice");
      expect(result.map((w) => w.chain).sort()).toEqual(["evm", "solana"]);
    });

    test("preserves existing wallets and only fills gaps", async () => {
      const evm = await generateAgentWallet(testVault.vault, "alice", "evm");
      const result = await ensureAgentWallets(testVault.vault, "alice");
      const resultEvm = result.find((w) => w.chain === "evm");
      expect(resultEvm?.address).toBe(evm.address);
      expect(result.find((w) => w.chain === "solana")).toBeDefined();
    });
  });

  describe("setAgentWallet", () => {
    test("rejects empty private key", async () => {
      await expect(
        setAgentWallet(testVault.vault, "alice", "evm", "", "0xabc"),
      ).rejects.toThrow(/privateKey required/);
    });

    test("rejects empty address", async () => {
      await expect(
        setAgentWallet(testVault.vault, "alice", "evm", "0xdeadbeef", ""),
      ).rejects.toThrow(/address required/);
    });

    test("stores supplied values verbatim", async () => {
      const fakeKey = "0x" + "a".repeat(64);
      const fakeAddr = "0x" + "b".repeat(40);
      const desc = await setAgentWallet(
        testVault.vault,
        "alice",
        "evm",
        fakeKey,
        fakeAddr,
      );
      expect(desc.address).toBe(fakeAddr);
      const revealed = await revealAgentWalletPrivateKey(
        testVault.vault,
        "alice",
        "evm",
      );
      expect(revealed).toBe(fakeKey);
    });
  });

  describe("removeAgentWallet / removeAllAgentWallets", () => {
    test("removeAgentWallet drops one chain", async () => {
      await generateAgentWallet(testVault.vault, "alice", "evm");
      await generateAgentWallet(testVault.vault, "alice", "solana");
      await removeAgentWallet(testVault.vault, "alice", "evm");
      expect(await hasAgentWallet(testVault.vault, "alice", "evm")).toBe(false);
      expect(await hasAgentWallet(testVault.vault, "alice", "solana")).toBe(
        true,
      );
    });

    test("removeAgentWallet is idempotent", async () => {
      await expect(
        removeAgentWallet(testVault.vault, "alice", "evm"),
      ).resolves.toBeUndefined();
    });

    test("removeAllAgentWallets clears every chain for one agent", async () => {
      await generateAgentWallet(testVault.vault, "alice", "evm");
      await generateAgentWallet(testVault.vault, "alice", "solana");
      await generateAgentWallet(testVault.vault, "bob", "evm");
      await removeAllAgentWallets(testVault.vault, "alice");
      expect(await listAgentWallets(testVault.vault, "alice")).toHaveLength(0);
      expect(await listAgentWallets(testVault.vault, "bob")).toHaveLength(1);
    });
  });

  describe("input validation", () => {
    test("rejects empty agentId", async () => {
      await expect(
        generateAgentWallet(testVault.vault, "", "evm"),
      ).rejects.toThrow(/agentId must be a non-empty string/);
    });

    test("rejects whitespace-only agentId", async () => {
      await expect(
        generateAgentWallet(testVault.vault, "   ", "evm"),
      ).rejects.toThrow(/agentId must be a non-empty string/);
    });
  });
});
