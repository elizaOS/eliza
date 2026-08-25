import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultService } from "./VaultService";

// getConnection is mocked at the module level so no real RPC connection is
// ever constructed; the test controls the connection's responses directly.
const connectionMock = vi.hoisted(() => ({
  getBalance: vi.fn(async () => 0),
  getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
}));

vi.mock("../utils/solanaClient", () => ({
  getConnection: () => connectionMock,
}));

// 64 bytes of valid hex (128 chars).
const VALID_HEX = "ab".repeat(64);
// A real, valid 32-byte Solana public key (SystemProgram id).
const VALID_PUBKEY = "11111111111111111111111111111111";

describe("VaultService key handling", () => {
  beforeEach(() => {
    connectionMock.getBalance.mockResolvedValue(0);
    connectionMock.getParsedTokenAccountsByOwner.mockResolvedValue({
      value: [],
    });
  });

  it("creates a vault with a public key and hex-encrypted secret", async () => {
    const service = new VaultService();
    const vault = await service.createVault("user-1");
    // A public key string must be produced and the secret must be hex-encoded
    // exactly (64 bytes → 128 hex chars), never truncated or lossy.
    expect(typeof vault.publicKey).toBe("string");
    expect(vault.publicKey.length).toBeGreaterThanOrEqual(32);
    expect(vault.secretKeyEncrypted).toMatch(/^[0-9a-f]{128}$/);
    expect(await service.getVaultPublicKey("user-1")).toBe(vault.publicKey);
  });

  it("derives a keypair from a valid 64-byte hex secret", async () => {
    const service = new VaultService();
    const kp = await service.getVaultKeypair("user-1", VALID_HEX);
    expect(kp.secretKey).toHaveLength(64);
  });

  it("fails loudly when the encrypted secret is not 64 bytes", async () => {
    const service = new VaultService();
    // Any malformed secret surfaces the uniform fail-loud error — the inner
    // length diagnostics are deliberately collapsed into one typed message so
    // callers cannot mistake a garbage keypair for a real one.
    await expect(service.getVaultKeypair("user-1", "abcd")).rejects.toThrow(
      "Could not derive Keypair from the provided secret.",
    );
  });

  it("fails loudly on truncated non-hex input instead of deriving a partial key", async () => {
    const service = new VaultService();
    // Buffer.from truncates at the first non-hex pair; the truncated buffer
    // must never be passed on as a keypair.
    await expect(
      service.getVaultKeypair("user-1", "zz".repeat(64)),
    ).rejects.toThrow("Could not derive Keypair from the provided secret.");
  });

  it("returns null on a public-key cache miss (no fabricated key)", async () => {
    const service = new VaultService();
    expect(await service.getVaultPublicKey("unknown-user")).toBeNull();
  });

  it("rejects a private-key export with a too-short confirmation token", async () => {
    const service = new VaultService();
    await expect(
      service.exportPrivateKey("user-1", VALID_HEX, "short"),
    ).rejects.toThrow("Invalid confirmation token");
  });

  it("rejects a confirmation token with unsafe characters", async () => {
    const service = new VaultService();
    await expect(
      service.exportPrivateKey("user-1", VALID_HEX, `${"x".repeat(40)}!`),
    ).rejects.toThrow("Invalid confirmation token");
  });

  it("rejects an over-long confirmation token", async () => {
    const service = new VaultService();
    await expect(
      service.exportPrivateKey("user-1", VALID_HEX, "x".repeat(300)),
    ).rejects.toThrow("Invalid confirmation token");
  });

  it("exports the base58-encoded private key for a valid token", async () => {
    const service = new VaultService();
    const exported = await service.exportPrivateKey(
      "user-1",
      VALID_HEX,
      "c".repeat(40),
    );
    // A base58-encoded string (no 0/O/I/l) of the 64-byte secret.
    expect(exported).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,120}$/);
  });

  it("surfaces a structured failure when exporting with a malformed secret", async () => {
    const service = new VaultService();
    await expect(
      service.exportPrivateKey("user-1", "zz", "c".repeat(40)),
    ).rejects.toThrow("Failed to export private key");
  });

  it("returns SOL and SPL balances for a valid public key", async () => {
    connectionMock.getBalance.mockResolvedValue(5_000_000_000); // 5 SOL in lamports
    connectionMock.getParsedTokenAccountsByOwner.mockResolvedValue({
      value: [
        {
          account: {
            data: {
              parsed: {
                info: {
                  mint: "mint1",
                  tokenAmount: { amount: "1000", decimals: 6, uiAmount: 0.001 },
                },
              },
            },
          },
        },
      ],
    });
    const service = new VaultService();
    await service.start({} as never);
    const balances = await service.getBalances(VALID_PUBKEY);
    expect(balances).toHaveLength(2);
    expect(balances[0]).toMatchObject({
      address: "SOL",
      balance: "5000000000",
      decimals: 9,
      uiAmount: 5,
    });
    expect(balances[1]).toMatchObject({
      address: "mint1",
      balance: "1000",
      decimals: 6,
    });
  });

  it("fails loudly when fetching balances for an invalid public key", async () => {
    const service = new VaultService();
    await service.start({} as never);
    await expect(service.getBalances("not-a-pubkey")).rejects.toThrow(
      "Failed to fetch balances",
    );
  });
});
