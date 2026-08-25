/**
 * Behavioral coverage for per-agent vault wallets: key encoding isolation,
 * public descriptors versus private-key reveal, generate/ensure/remove
 * idempotence, malformed-entry rejection, and the opt-in process.env bridge.
 * Drives the real module against an in-process vault (`createTestVault`).
 * TEE-gate refusal and decryption-quarantine stay in their dedicated suites.
 */
import {
  createTestVault,
  readEntryMeta,
  type TestVault,
  VaultMissError,
} from "@elizaos/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveEvmAddress } from "../api/wallet.ts";
import { clearTeeBootGateState } from "../services/tee-boot-gate-state.ts";
import {
  __test__,
  bridgeAgentWalletsToProcessEnv,
  ensureAgentWallets,
  generateAgentWallet,
  getAgentWalletDescriptor,
  hasAgentWallet,
  listAgentWallets,
  removeAgentWallet,
  revealAgentWalletPrivateKey,
  setAgentWallet,
} from "./agent-wallets.ts";

const AGENT_ID = "wallet-coverage-agent";
const KNOWN_EVM_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const KNOWN_EVM_ADDRESS = deriveEvmAddress(KNOWN_EVM_PRIVATE_KEY);
const SOLANA_PRIVATE_KEY = "[1,2,3,4]";
const SOLANA_ADDRESS = "So11111111111111111111111111111111111111112";

const ENV_KEYS = [
  "ELIZA_AGENT_WALLET_AS_USER",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
] as const;

function restoreEnv(
  snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>,
) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("agent-wallets key layout", () => {
  it("rejects empty, whitespace-only, and non-string agent ids", () => {
    expect(() => __test__.walletKey("", "evm")).toThrow(TypeError);
    expect(() => __test__.walletKey("   ", "solana")).toThrow(
      /agentId must be a non-empty string/,
    );
    expect(() => __test__.walletKey(null as unknown as string, "evm")).toThrow(
      TypeError,
    );
  });

  it("trims agent ids and encodes dots so they cannot split the four-part key", () => {
    expect(__test__.walletKey("  eliza  ", "evm")).toBe(
      "agent.eliza.wallet.evm",
    );
    expect(__test__.walletKey("alice.bob", "solana")).toBe(
      "agent.alice%2Ebob.wallet.solana",
    );
    expect(__test__.agentPrefix("alice.bob")).toBe("agent.alice%2Ebob.wallet");
  });

  it("round-trips encoded agent ids, including slash and percent characters", () => {
    const dotted = __test__.walletKey("alice.bob", "evm");
    expect(__test__.parseAgentWalletKey(dotted)).toEqual({
      agentId: "alice.bob",
      chain: "evm",
    });
    const slashed = __test__.walletKey("org/team", "solana");
    expect(__test__.parseAgentWalletKey(slashed)).toEqual({
      agentId: "org/team",
      chain: "solana",
    });
  });

  it("returns null for unparseable keys: wrong arity, prefix, segment, empty id, invalid chain", () => {
    expect(__test__.parseAgentWalletKey("agent.eliza.wallet")).toBeNull();
    expect(
      __test__.parseAgentWalletKey("agent.alice.bob.wallet.evm"),
    ).toBeNull();
    expect(__test__.parseAgentWalletKey("user.eliza.wallet.evm")).toBeNull();
    expect(__test__.parseAgentWalletKey("agent.eliza.secret.evm")).toBeNull();
    expect(__test__.parseAgentWalletKey("agent..wallet.evm")).toBeNull();
    expect(
      __test__.parseAgentWalletKey("agent.eliza.wallet.bitcoin"),
    ).toBeNull();
    expect(__test__.parseAgentWalletKey("agent.eliza.wallet.EVM")).toBeNull();
  });

  it("derives an EVM address and refuses Solana re-derivation", () => {
    expect(__test__.deriveAddressFor("evm", KNOWN_EVM_PRIVATE_KEY)).toBe(
      KNOWN_EVM_ADDRESS,
    );
    expect(() =>
      __test__.deriveAddressFor("solana", SOLANA_PRIVATE_KEY),
    ).toThrow(/only supports EVM/);
  });
});

describe("agent-wallets vault operations", () => {
  let test: TestVault;
  let envSnapshot: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(async () => {
    envSnapshot = {
      ELIZA_AGENT_WALLET_AS_USER: process.env.ELIZA_AGENT_WALLET_AS_USER,
      EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY,
      SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
    };
    for (const key of ENV_KEYS) delete process.env[key];
    clearTeeBootGateState();
    test = await createTestVault();
  });

  afterEach(async () => {
    clearTeeBootGateState();
    restoreEnv(envSnapshot);
    await test.dispose();
  });

  describe("setAgentWallet / getAgentWalletDescriptor / hasAgentWallet", () => {
    it("returns null and has=false when the queue is empty (no wallet for that chain)", async () => {
      expect(
        await getAgentWalletDescriptor(test.vault, AGENT_ID, "evm"),
      ).toBeNull();
      expect(await hasAgentWallet(test.vault, AGENT_ID, "evm")).toBe(false);
      expect(await hasAgentWallet(test.vault, AGENT_ID, "solana")).toBe(false);
    });

    it("persists a public descriptor without exposing the private key", async () => {
      const before = Date.now();
      const descriptor = await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        KNOWN_EVM_ADDRESS,
        "coverage-set",
      );
      const after = Date.now();

      expect(descriptor).toEqual({
        agentId: AGENT_ID,
        chain: "evm",
        address: KNOWN_EVM_ADDRESS,
        lastModified: descriptor.lastModified,
      });
      expect(descriptor.lastModified).toBeGreaterThanOrEqual(before);
      expect(descriptor.lastModified).toBeLessThanOrEqual(after);
      expect(descriptor).not.toHaveProperty("privateKey");

      expect(await hasAgentWallet(test.vault, AGENT_ID, "evm")).toBe(true);
      expect(
        await getAgentWalletDescriptor(test.vault, AGENT_ID, "evm"),
      ).toEqual(descriptor);
      expect(
        await revealAgentWalletPrivateKey(
          test.vault,
          AGENT_ID,
          "evm",
          "coverage-reveal",
        ),
      ).toBe(KNOWN_EVM_PRIVATE_KEY);

      const meta = await readEntryMeta(
        test.vault,
        __test__.walletKey(AGENT_ID, "evm"),
      );
      expect(meta?.category).toBe("wallet");
      expect(meta?.label).toBe(`agent ${AGENT_ID} (evm)`);
    });

    it("replaces an existing (agentId, chain) row and stamps a new lastModified", async () => {
      const first = await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        "0x0000000000000000000000000000000000000001",
      );
      const replacementAddress = "0x0000000000000000000000000000000000000002";
      const second = await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        replacementAddress,
      );
      expect(second.address).toBe(replacementAddress);
      expect(second.lastModified).toBeGreaterThanOrEqual(first.lastModified);
      expect(
        (await getAgentWalletDescriptor(test.vault, AGENT_ID, "evm"))?.address,
      ).toBe(replacementAddress);
    });

    it("rejects missing, empty, and whitespace private keys or addresses", async () => {
      await expect(
        setAgentWallet(test.vault, AGENT_ID, "evm", "", KNOWN_EVM_ADDRESS),
      ).rejects.toThrow(/privateKey required/);
      await expect(
        setAgentWallet(test.vault, AGENT_ID, "evm", "   ", KNOWN_EVM_ADDRESS),
      ).rejects.toThrow(TypeError);
      await expect(
        setAgentWallet(
          test.vault,
          AGENT_ID,
          "evm",
          null as unknown as string,
          KNOWN_EVM_ADDRESS,
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        setAgentWallet(test.vault, AGENT_ID, "evm", KNOWN_EVM_PRIVATE_KEY, ""),
      ).rejects.toThrow(/address required/);
      await expect(
        setAgentWallet(
          test.vault,
          AGENT_ID,
          "evm",
          KNOWN_EVM_PRIVATE_KEY,
          "   ",
        ),
      ).rejects.toThrow(TypeError);
    });

    it("throws on a stored entry whose JSON is missing required fields", async () => {
      await test.vault.set(
        __test__.walletKey(AGENT_ID, "evm"),
        JSON.stringify({ chain: "evm", address: KNOWN_EVM_ADDRESS }),
        { sensitive: true },
      );
      await expect(
        getAgentWalletDescriptor(test.vault, AGENT_ID, "evm"),
      ).rejects.toThrow(/stored entry malformed/);
    });
  });

  describe("listAgentWallets", () => {
    it("returns an empty list when the agent has no wallets", async () => {
      expect(await listAgentWallets(test.vault, AGENT_ID)).toEqual([]);
    });

    it("returns a single-element list for one chain and both chains when both exist", async () => {
      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        KNOWN_EVM_ADDRESS,
      );
      const single = await listAgentWallets(test.vault, AGENT_ID);
      expect(single).toHaveLength(1);
      expect(single[0]?.chain).toBe("evm");
      expect(single[0]?.address).toBe(KNOWN_EVM_ADDRESS);

      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "solana",
        SOLANA_PRIVATE_KEY,
        SOLANA_ADDRESS,
      );
      const both = await listAgentWallets(test.vault, AGENT_ID);
      expect(both.map((wallet) => wallet.chain).sort()).toEqual([
        "evm",
        "solana",
      ]);
    });

    it("skips unparseable keys under the agent prefix (invalid chain)", async () => {
      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        KNOWN_EVM_ADDRESS,
      );
      await test.vault.set(
        `${__test__.agentPrefix(AGENT_ID)}.bitcoin`,
        JSON.stringify({
          chain: "bitcoin",
          address: "1abc",
          privateKey: "k",
          lastModified: 1,
        }),
        { sensitive: true },
      );
      const listed = await listAgentWallets(test.vault, AGENT_ID);
      expect(listed.map((wallet) => wallet.chain)).toEqual(["evm"]);
    });

    it("keeps dotted agent ids isolated from the unencoded prefix", async () => {
      await setAgentWallet(
        test.vault,
        "alice.bob",
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        KNOWN_EVM_ADDRESS,
      );
      expect(await listAgentWallets(test.vault, "alice")).toEqual([]);
      expect(await listAgentWallets(test.vault, "alice.bob")).toHaveLength(1);
      expect(await hasAgentWallet(test.vault, "alice.bob", "evm")).toBe(true);
      expect(await hasAgentWallet(test.vault, "alice", "evm")).toBe(false);
    });
  });

  describe("revealAgentWalletPrivateKey", () => {
    it("reveals the stored private key for a present wallet", async () => {
      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "solana",
        SOLANA_PRIVATE_KEY,
        SOLANA_ADDRESS,
      );
      await expect(
        revealAgentWalletPrivateKey(test.vault, AGENT_ID, "solana"),
      ).resolves.toBe(SOLANA_PRIVATE_KEY);
    });

    it("surfaces a vault miss when the item is absent", async () => {
      await expect(
        revealAgentWalletPrivateKey(test.vault, AGENT_ID, "evm"),
      ).rejects.toBeInstanceOf(VaultMissError);
    });
  });

  describe("generateAgentWallet", () => {
    it("creates a usable wallet whose address matches the revealed key for EVM", async () => {
      const descriptor = await generateAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        "coverage-generate",
      );
      expect(descriptor.chain).toBe("evm");
      expect(descriptor.address.startsWith("0x")).toBe(true);
      const pk = await revealAgentWalletPrivateKey(test.vault, AGENT_ID, "evm");
      expect(deriveEvmAddress(pk)).toBe(descriptor.address);
    });

    it("throws before writing when the abort signal is already aborted", async () => {
      const signal = AbortSignal.abort();
      await expect(
        generateAgentWallet(test.vault, AGENT_ID, "evm", "coverage", signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await hasAgentWallet(test.vault, AGENT_ID, "evm")).toBe(false);
    });
  });

  describe("ensureAgentWallets", () => {
    it("generates both missing chains on an empty agent", async () => {
      const wallets = await ensureAgentWallets(
        test.vault,
        AGENT_ID,
        "coverage-ensure",
      );
      expect(wallets.map((wallet) => wallet.chain).sort()).toEqual([
        "evm",
        "solana",
      ]);
      expect(await hasAgentWallet(test.vault, AGENT_ID, "evm")).toBe(true);
      expect(await hasAgentWallet(test.vault, AGENT_ID, "solana")).toBe(true);
    });

    it("leaves an existing wallet alone and only fills the missing chain", async () => {
      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        KNOWN_EVM_ADDRESS,
      );
      const wallets = await ensureAgentWallets(test.vault, AGENT_ID);
      const evm = wallets.find((wallet) => wallet.chain === "evm");
      const solana = wallets.find((wallet) => wallet.chain === "solana");
      expect(evm?.address).toBe(KNOWN_EVM_ADDRESS);
      expect(solana?.address).toBeTruthy();
      expect(solana?.address).not.toBe(KNOWN_EVM_ADDRESS);
      expect(
        await revealAgentWalletPrivateKey(test.vault, AGENT_ID, "evm"),
      ).toBe(KNOWN_EVM_PRIVATE_KEY);
    });

    it("is idempotent: a second ensure returns the same addresses", async () => {
      const first = await ensureAgentWallets(test.vault, AGENT_ID);
      const second = await ensureAgentWallets(test.vault, AGENT_ID);
      expect(
        second.map((wallet) => `${wallet.chain}:${wallet.address}`).sort(),
      ).toEqual(
        first.map((wallet) => `${wallet.chain}:${wallet.address}`).sort(),
      );
    });

    it("rethrows a non-decryption parse error instead of replacing the row", async () => {
      await test.vault.set(__test__.walletKey(AGENT_ID, "evm"), "{not-json", {
        sensitive: true,
      });
      await expect(ensureAgentWallets(test.vault, AGENT_ID)).rejects.toThrow();
      expect(await test.vault.has(__test__.walletKey(AGENT_ID, "evm"))).toBe(
        true,
      );
      await expect(
        test.vault.get(__test__.walletKey(AGENT_ID, "evm")),
      ).resolves.toBe("{not-json");
    });

    it("does not write wallets when aborted before the first chain", async () => {
      await expect(
        ensureAgentWallets(
          test.vault,
          AGENT_ID,
          "coverage",
          AbortSignal.abort(),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await listAgentWallets(test.vault, AGENT_ID)).toEqual([]);
    });
  });

  describe("bridgeAgentWalletsToProcessEnv", () => {
    it("does not write process.env unless ELIZA_AGENT_WALLET_AS_USER is exactly 1", async () => {
      const wallets = await ensureAgentWallets(test.vault, AGENT_ID);
      await bridgeAgentWalletsToProcessEnv(test.vault, AGENT_ID, wallets);
      expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
      expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();

      process.env.ELIZA_AGENT_WALLET_AS_USER = "true";
      await bridgeAgentWalletsToProcessEnv(test.vault, AGENT_ID, wallets);
      expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    });

    it("bridges both chains when opted in and the env slots are empty", async () => {
      process.env.ELIZA_AGENT_WALLET_AS_USER = "1";
      const wallets = await ensureAgentWallets(test.vault, AGENT_ID);
      expect(process.env.EVM_PRIVATE_KEY?.length ?? 0).toBeGreaterThan(0);
      expect(process.env.SOLANA_PRIVATE_KEY?.length ?? 0).toBeGreaterThan(0);
      expect(deriveEvmAddress(process.env.EVM_PRIVATE_KEY ?? "")).toBe(
        wallets.find((wallet) => wallet.chain === "evm")?.address,
      );
    });

    it("lets a user-set env value win and treats whitespace-only as empty", async () => {
      process.env.ELIZA_AGENT_WALLET_AS_USER = "1";
      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        KNOWN_EVM_ADDRESS,
      );
      process.env.EVM_PRIVATE_KEY = "user-owned-key";
      await bridgeAgentWalletsToProcessEnv(
        test.vault,
        AGENT_ID,
        [
          {
            agentId: AGENT_ID,
            chain: "evm",
            address: KNOWN_EVM_ADDRESS,
            lastModified: Date.now(),
          },
        ],
        "coverage-bridge",
      );
      expect(process.env.EVM_PRIVATE_KEY).toBe("user-owned-key");

      process.env.EVM_PRIVATE_KEY = "   ";
      await bridgeAgentWalletsToProcessEnv(test.vault, AGENT_ID, [
        {
          agentId: AGENT_ID,
          chain: "evm",
          address: KNOWN_EVM_ADDRESS,
          lastModified: Date.now(),
        },
      ]);
      expect(process.env.EVM_PRIVATE_KEY).toBe(KNOWN_EVM_PRIVATE_KEY);
    });

    it("is a no-op for an empty descriptor queue even when opted in", async () => {
      process.env.ELIZA_AGENT_WALLET_AS_USER = "1";
      await bridgeAgentWalletsToProcessEnv(test.vault, AGENT_ID, []);
      expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
      expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
    });

    it("throws when opted in with descriptors and the abort signal is aborted", async () => {
      process.env.ELIZA_AGENT_WALLET_AS_USER = "1";
      await expect(
        bridgeAgentWalletsToProcessEnv(
          test.vault,
          AGENT_ID,
          [
            {
              agentId: AGENT_ID,
              chain: "evm",
              address: KNOWN_EVM_ADDRESS,
              lastModified: 1,
            },
          ],
          "coverage",
          AbortSignal.abort(),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    });
  });

  describe("removeAgentWallet", () => {
    it("removes one chain without touching the other, and is idempotent for a missing item", async () => {
      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "evm",
        KNOWN_EVM_PRIVATE_KEY,
        KNOWN_EVM_ADDRESS,
      );
      await setAgentWallet(
        test.vault,
        AGENT_ID,
        "solana",
        SOLANA_PRIVATE_KEY,
        SOLANA_ADDRESS,
      );

      await removeAgentWallet(test.vault, AGENT_ID, "evm");
      expect(await hasAgentWallet(test.vault, AGENT_ID, "evm")).toBe(false);
      expect(await hasAgentWallet(test.vault, AGENT_ID, "solana")).toBe(true);
      expect(
        await readEntryMeta(test.vault, __test__.walletKey(AGENT_ID, "evm")),
      ).toBeNull();

      await expect(
        removeAgentWallet(test.vault, AGENT_ID, "evm"),
      ).resolves.toBeUndefined();
      expect(await hasAgentWallet(test.vault, AGENT_ID, "solana")).toBe(true);
    });
  });
});
