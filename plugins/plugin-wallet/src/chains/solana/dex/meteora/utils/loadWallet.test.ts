/**
 * Private-key decode-ladder tests for the Meteora wallet loader.
 *
 * Materiality: `loadWallet` handles Solana private keys (base58, then base64
 * fallback) and constructs signing keypairs. The decode ladder's failure
 * behavior is security-sensitive: a malformed key must fail loudly rather
 * than silently producing a wrong/empty keypair, and a missing key must be a
 * hard error. These tests pin the ladder and its error messages.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bs58DecodeMock } = vi.hoisted(() => ({ bs58DecodeMock: vi.fn() }));

vi.mock("@solana/web3.js", () => {
  return {
    Connection: class Connection {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    },
    Keypair: {
      fromSecretKey: (secretKey: Uint8Array) => {
        if (secretKey.length !== 64) {
          throw new Error("wrong length");
        }
        return { secretKey, tag: "keypair" };
      },
    },
    PublicKey: class PublicKey {
      value: string;
      constructor(value: string) {
        if (typeof value !== "string" || value.length < 5) {
          throw new Error("Invalid public key input");
        }
        this.value = value;
      }
    },
  };
});

vi.mock("bs58", () => ({
  default: { decode: bs58DecodeMock },
}));

import { loadWallet } from "./loadWallet";

const B64_KEY = Buffer.alloc(64, 7).toString("base64"); // decodes to 64 bytes

function makeRuntime(settings: Record<string, string | undefined>) {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as Parameters<typeof loadWallet>[0];
}

describe("loadWallet", () => {
  beforeEach(() => {
    bs58DecodeMock.mockReset();
  });

  it("loads a keypair via base58 and defaults the RPC URL when unset", async () => {
    bs58DecodeMock.mockReturnValue(Uint8Array.from(Buffer.alloc(64, 1)));
    const result = await loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: "base58key" }));
    expect(result.signer).toBeDefined();
    expect(result.signer?.tag).toBe("keypair");
    expect(result.connection.url).toBe("https://api.mainnet-beta.solana.com");
    expect(bs58DecodeMock).toHaveBeenCalledWith("base58key");
  });

  it("honors an explicitly configured RPC URL", async () => {
    bs58DecodeMock.mockReturnValue(Uint8Array.from(Buffer.alloc(64, 1)));
    const result = await loadWallet(
      makeRuntime({ SOLANA_PRIVATE_KEY: "base58key", SOLANA_RPC_URL: "https://rpc.custom" })
    );
    expect(result.connection.url).toBe("https://rpc.custom");
  });

  it("falls back to base64 when base58 decode fails", async () => {
    bs58DecodeMock.mockImplementation(() => {
      throw new Error("invalid base58");
    });
    const result = await loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: B64_KEY }));
    expect(result.signer).toBeDefined();
  });

  it("throws a clear error when both base58 and base64 fail", async () => {
    bs58DecodeMock.mockImplementation(() => {
      throw new Error("invalid base58");
    });
    await expect(
      loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: "!!!not-a-key!!!" }))
    ).rejects.toThrow("Invalid private key format");
  });

  it("throws when the private key is missing entirely", async () => {
    await expect(loadWallet(makeRuntime({}))).rejects.toThrow("Private key not found in settings");
  });

  it("treats an empty-string private key as missing", async () => {
    await expect(loadWallet(makeRuntime({ SOLANA_PRIVATE_KEY: "" }))).rejects.toThrow(
      "Private key not found in settings"
    );
  });

  it("loads a public-key-only wallet when requirePrivateKey is false", async () => {
    const result = await loadWallet(makeRuntime({ SOLANA_PUBLIC_KEY: "pubkey" }), false);
    expect(result.address?.value).toBe("pubkey");
    expect(result.signer).toBeUndefined();
  });

  it("supports the WALLET_PUBLIC_KEY alias in read-only mode", async () => {
    const result = await loadWallet(makeRuntime({ WALLET_PUBLIC_KEY: "walletpub" }), false);
    expect(result.address?.value).toBe("walletpub");
  });

  it("throws when the public key is missing in read-only mode", async () => {
    await expect(loadWallet(makeRuntime({}), false)).rejects.toThrow(
      "Public key not found in settings"
    );
  });

  it("propagates PublicKey constructor failures for malformed keys", async () => {
    await expect(loadWallet(makeRuntime({ SOLANA_PUBLIC_KEY: "abc" }), false)).rejects.toThrow(
      "Invalid public key input"
    );
  });
});
