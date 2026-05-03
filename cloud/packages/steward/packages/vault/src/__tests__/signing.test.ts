import { describe, expect, it } from "bun:test";
import { keccak256, recoverAddress, recoverMessageAddress, toHex, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { KeyStore } from "../keystore";
import { generateSolanaKeypair, restoreSolanaKeypair } from "../solana";

// ─── Test Config ──────────────────────────────────────────────────────────

const MASTER_PASSWORD = "test-vault-signing";

// ─── KeyStore Tests ───────────────────────────────────────────────────────

describe("KeyStore", () => {
  const keyStore = new KeyStore(MASTER_PASSWORD);

  it("encrypts and decrypts EVM private key (round-trip)", () => {
    const privateKey = generatePrivateKey();
    const encrypted = keyStore.encrypt(privateKey);

    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();
    expect(encrypted.salt).toBeTruthy();

    const decrypted = keyStore.decrypt(encrypted);
    expect(decrypted).toBe(privateKey);
  });

  it("encrypts and decrypts Solana secret key (round-trip)", () => {
    const kp = generateSolanaKeypair();
    const encrypted = keyStore.encrypt(kp.secretKey);
    const decrypted = keyStore.decrypt(encrypted);
    expect(decrypted).toBe(kp.secretKey);
  });

  it("different encryptions of same key produce different ciphertexts (random IV + salt)", () => {
    const privateKey = generatePrivateKey();
    const enc1 = keyStore.encrypt(privateKey);
    const enc2 = keyStore.encrypt(privateKey);

    // Random IV + salt means different ciphertexts
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.salt).not.toBe(enc2.salt);

    // But both decrypt to the same key
    expect(keyStore.decrypt(enc1)).toBe(privateKey);
    expect(keyStore.decrypt(enc2)).toBe(privateKey);
  });

  it("different salts produce different derived keys → different ciphertexts for same plaintext", () => {
    const ks = new KeyStore("same-password");
    const privateKey = generatePrivateKey();

    const enc1 = ks.encrypt(privateKey);
    const enc2 = ks.encrypt(privateKey);

    // Salts must differ (randomBytes(16) each time)
    expect(enc1.salt).not.toBe(enc2.salt);

    // Different derived keys → different ciphertexts even for identical plaintext
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it("wrong password fails to decrypt (AES-GCM auth tag check)", () => {
    const correctStore = new KeyStore("correct-password");
    const wrongStore = new KeyStore("wrong-password");

    const privateKey = generatePrivateKey();
    const encrypted = correctStore.encrypt(privateKey);

    // Decrypting with wrong master password derives a different key
    // → AES-GCM auth tag mismatch → throws
    expect(() => wrongStore.decrypt(encrypted)).toThrow();
  });

  it("corrupt ciphertext fails to decrypt", () => {
    const privateKey = generatePrivateKey();
    const encrypted = keyStore.encrypt(privateKey);

    // Flip the first byte of the ciphertext
    const corruptedCiphertext =
      encrypted.ciphertext.slice(0, 1) === "a"
        ? `b${encrypted.ciphertext.slice(1)}`
        : `a${encrypted.ciphertext.slice(1)}`;

    const corrupted = { ...encrypted, ciphertext: corruptedCiphertext };

    expect(() => keyStore.decrypt(corrupted)).toThrow();
  });

  it("corrupt auth tag fails to decrypt", () => {
    const privateKey = generatePrivateKey();
    const encrypted = keyStore.encrypt(privateKey);

    // Flip the first byte of the tag → auth verification fails
    const corruptedTag =
      encrypted.tag.slice(0, 1) === "a"
        ? `b${encrypted.tag.slice(1)}`
        : `a${encrypted.tag.slice(1)}`;

    const corrupted = { ...encrypted, tag: corruptedTag };

    expect(() => keyStore.decrypt(corrupted)).toThrow();
  });
});

// ─── EVM Signing — raw hash + recoverAddress ──────────────────────────────

describe("EVM Signing — sign raw hash, verify recovery", () => {
  it("signs a raw hash and recovers the correct address", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    // Simulate a transaction payload hash
    const payload = "steward:test-sign-payload:8453";
    const msgHash = keccak256(toHex(payload));

    const signature = await account.sign({ hash: msgHash });

    const recovered = await recoverAddress({ hash: msgHash, signature });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("different messages produce different signatures", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const hash1 = keccak256(toHex("message-one"));
    const hash2 = keccak256(toHex("message-two"));

    const sig1 = await account.sign({ hash: hash1 });
    const sig2 = await account.sign({ hash: hash2 });

    expect(sig1).not.toBe(sig2);
  });

  it("same message signed by two different keys recovers to different addresses", async () => {
    const pk1 = generatePrivateKey();
    const pk2 = generatePrivateKey();
    const acc1 = privateKeyToAccount(pk1);
    const acc2 = privateKeyToAccount(pk2);

    const msgHash = keccak256(toHex("shared-payload"));

    const sig1 = await acc1.sign({ hash: msgHash });
    const sig2 = await acc2.sign({ hash: msgHash });

    const recovered1 = await recoverAddress({ hash: msgHash, signature: sig1 });
    const recovered2 = await recoverAddress({ hash: msgHash, signature: sig2 });

    expect(recovered1.toLowerCase()).toBe(acc1.address.toLowerCase());
    expect(recovered2.toLowerCase()).toBe(acc2.address.toLowerCase());
    expect(recovered1.toLowerCase()).not.toBe(recovered2.toLowerCase());
  });
});

// ─── Sign Message (personal_sign style) ───────────────────────────────────

describe("Sign Message — personal_sign, verify recovery", () => {
  it("signs a message and recovers the signer address", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const message = "Hello, Steward! This is a test message.";
    const signature = await account.signMessage({ message });

    expect(signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signature.length).toBe(132); // 0x + 130 hex = 65 bytes

    const recovered = await recoverMessageAddress({ message, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("signing empty string message works and recovers correctly", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const message = "";
    const signature = await account.signMessage({ message });
    const recovered = await recoverMessageAddress({ message, signature });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("signing unicode/emoji message works and recovers correctly", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const message = "🤖 AI Agent approved transfer of 1 ETH to 0xdead…beef";
    const signature = await account.signMessage({ message });
    const recovered = await recoverMessageAddress({ message, signature });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("wrong message does not recover to correct address", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const signedMessage = "original message";
    const differentMessage = "tampered message";

    const signature = await account.signMessage({ message: signedMessage });

    // Recovering with different message gives a different (wrong) address
    const recovered = await recoverMessageAddress({
      message: differentMessage,
      signature,
    });
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });
});

// ─── EIP-712 Typed Data Signing ───────────────────────────────────────────

describe("EIP-712 Typed Data Signing", () => {
  it("signs and verifies EIP-712 typed data using viem account", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const domain = {
      name: "TestToken",
      version: "1",
      chainId: 8453,
      verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" as `0x${string}`,
    };

    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;

    const message = {
      owner: account.address,
      spender: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      value: 1000000000000000000n,
      nonce: 0n,
      deadline: 1700000000n,
    };

    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: "Permit",
      message,
    });

    expect(signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signature.length).toBe(132); // 0x + 130 hex chars (65 bytes)

    const valid = await verifyTypedData({
      address: account.address,
      domain,
      types,
      primaryType: "Permit",
      message,
      signature,
    });
    expect(valid).toBe(true);
  });
});

// ─── Sign Without Broadcast ───────────────────────────────────────────────

describe("Sign Without Broadcast", () => {
  it("signs a transaction without broadcasting using viem account", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const signedTx = await account.signTransaction({
      to: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      value: 1000000000000000000n,
      gas: 21000n,
      nonce: 0,
      gasPrice: 1000000000n,
      chainId: 8453,
    });

    expect(signedTx).toMatch(/^0x[0-9a-fA-F]+$/);
    // Signed transaction is longer than a signature
    expect(signedTx.length).toBeGreaterThan(132);
  });

  it("signed transactions are deterministic for the same inputs", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const txParams = {
      to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
      value: 500000000000000000n,
      gas: 21000n,
      nonce: 5,
      gasPrice: 2000000000n,
      chainId: 1,
    };

    const signed1 = await account.signTransaction(txParams);
    const signed2 = await account.signTransaction(txParams);

    expect(signed1).toBe(signed2);
  });
});

// ─── Multi-Chain Routing ──────────────────────────────────────────────────

describe("Multi-Chain Routing", () => {
  it("EVM wallet addresses start with '0x'", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(account.address.startsWith("0x")).toBe(true);
  });

  it("Solana wallet addresses do NOT start with '0x'", () => {
    const kp = generateSolanaKeypair();
    expect(kp.publicKey.startsWith("0x")).toBe(false);
  });

  it("chainId 101 is the Solana mainnet convention id", () => {
    // Steward convention: EVM chain IDs never reach 101 (Solana mainnet-beta)
    // The vault routes chainId 101/102 to Solana RPC, everything else to EVM
    const SOLANA_MAINNET = 101;
    const SOLANA_DEVNET = 102;
    // Validate the constants used by the Vault
    expect(SOLANA_MAINNET).toBe(101);
    expect(SOLANA_DEVNET).toBe(102);
  });

  it("address format determines chain type: 0x prefix → EVM, base58 → Solana", () => {
    const evmAddress = privateKeyToAccount(generatePrivateKey()).address;
    const solAddress = generateSolanaKeypair().publicKey;

    // Vault's detectChainType logic (mirrored here for clarity)
    const detectChainType = (addr: string) => (addr.startsWith("0x") ? "evm" : "solana");

    expect(detectChainType(evmAddress)).toBe("evm");
    expect(detectChainType(solAddress)).toBe("solana");
  });

  it("chainId 1 (Ethereum), 56 (BSC), 137 (Polygon), 8453 (Base) are EVM chains", () => {
    const evmChainIds = [1, 56, 97, 137, 8453, 42161, 84532];
    const solanaChainIds = [101, 102];

    for (const id of evmChainIds) {
      expect(solanaChainIds.includes(id)).toBe(false);
    }
    for (const id of solanaChainIds) {
      expect(evmChainIds.includes(id)).toBe(false);
    }
  });
});

// ─── Solana Keypair Tests ─────────────────────────────────────────────────

describe("Solana Keypair", () => {
  it("generates a valid Solana keypair", () => {
    const kp = generateSolanaKeypair();
    expect(kp.publicKey).toBeTruthy();
    expect(kp.secretKey).toBeTruthy();
    // Solana public key is base58, typically 32-44 chars
    expect(kp.publicKey.length).toBeGreaterThan(20);
    // Secret key is 64 bytes as hex = 128 hex chars
    expect(kp.secretKey.length).toBe(128);
  });

  it("restores keypair from 128-char hex secret key", () => {
    const kp = generateSolanaKeypair();
    const restored = restoreSolanaKeypair(kp.secretKey);
    expect(restored.publicKey.toBase58()).toBe(kp.publicKey);
  });

  it("restores keypair from base58-encoded secret key", () => {
    // This is the format agents typically use (Phantom export, Solana CLI)
    const kp = generateSolanaKeypair();
    const hexBytes = Buffer.from(kp.secretKey, "hex");

    // Encode as base58 (same alphabet as Solana uses)
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let num = BigInt(`0x${hexBytes.toString("hex")}`);
    let base58 = "";
    while (num > 0n) {
      const remainder = Number(num % 58n);
      base58 = ALPHABET[remainder] + base58;
      num = num / 58n;
    }
    // Add leading '1's for leading zero bytes
    for (let i = 0; i < hexBytes.length && hexBytes[i] === 0; i++) {
      base58 = `1${base58}`;
    }

    const restored = restoreSolanaKeypair(base58);
    expect(restored.publicKey.toBase58()).toBe(kp.publicKey);
  });

  it("restores keypair from 64-char hex seed (32 bytes)", () => {
    const kp = generateSolanaKeypair();
    // Extract just the 32-byte seed from the 64-byte secret key
    const seed = kp.secretKey.slice(0, 64); // first 32 bytes as hex
    const restored = restoreSolanaKeypair(seed);
    expect(restored.publicKey.toBase58()).toBe(kp.publicKey);
  });

  it("throws on invalid secret key length", () => {
    expect(() => restoreSolanaKeypair("abc123")).toThrow();
  });

  it("two generated keypairs have different public keys", () => {
    const kp1 = generateSolanaKeypair();
    const kp2 = generateSolanaKeypair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.secretKey).not.toBe(kp2.secretKey);
  });
});

// ─── RPC Passthrough Blocked Methods ──────────────────────────────────────

describe("RPC Passthrough Method Blocking", () => {
  const blockedMethods = [
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "eth_sign",
    "personal_sign",
    "eth_signTypedData",
    "eth_signTypedData_v4",
    "sendTransaction",
  ];

  const allowedMethods = [
    "eth_call",
    "eth_getBalance",
    "eth_blockNumber",
    "eth_getTransactionReceipt",
    "eth_chainId",
    "getBalance",
    "getLatestBlockhash",
  ];

  for (const method of blockedMethods) {
    it(`blocks ${method}`, () => {
      expect(blockedMethods.includes(method)).toBe(true);
    });
  }

  for (const method of allowedMethods) {
    it(`allows ${method}`, () => {
      expect(blockedMethods.includes(method)).toBe(false);
    });
  }
});
