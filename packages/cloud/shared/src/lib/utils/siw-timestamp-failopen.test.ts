/**
 * SIWS and SIWE both compare an optional message timestamp with `<=` / `>`.
 * Those comparisons are FALSE for NaN, so a present-but-unparseable
 * `Expiration Time` made a signed message never expire, and an unparseable
 * `Not Before` made it immediately valid — a fail-open on two auth paths.
 *
 * Both helpers had the same shape and both are covered here: SIWS parsed the
 * field with a bare `new Date(...)`, and viem's `parseSiweMessage` hands back a
 * truthy `Invalid Date` for the same input. Fixing only one would have left the
 * identical hole one file away.
 *
 * Signatures are real (ed25519 via tweetnacl for SIWS, secp256k1 via viem for
 * SIWE); only the nonce store is an in-memory stand-in for Redis.
 */

import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { CompatibleRedis } from "../cache/redis-factory";
import { issueNonce as issueSiweNonce, validateAndConsumeSIWE } from "./siwe-helpers";
import { buildSiwsMessage, issueSiwsNonce, validateAndConsumeSIWS } from "./siws-helpers";

const HOST = "app.example.com";
const URI = "https://app.example.com";
const SOLANA_CHAIN = "solana:mainnet";
const EVM_CHAIN = 1;
// Generated per run, like the SIWS side's `nacl.sign.keyPair()` — a
// checked-in key literal is a secret shape the SCM scanner has to reason
// about, and nothing here depends on a fixed address.
const PRIVATE_KEY = generatePrivateKey();

function mockRedis(): CompatibleRedis {
  const store = new Map<string, string>();
  return {
    async setex(key: string, _ttl: number, value: string) {
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async getdel(key: string) {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  } as unknown as CompatibleRedis;
}

const MINUTE = 60_000;
const past = () => new Date(Date.now() - MINUTE).toISOString();
const future = () => new Date(Date.now() + MINUTE).toISOString();

/** Signs a SIWS message with the given extra timestamp lines appended. */
async function siws(extraLines: string[]): Promise<void> {
  const redis = mockRedis();
  const nonce = await issueSiwsNonce(redis, { uri: URI, chainId: SOLANA_CHAIN });
  const keyPair = nacl.sign.keyPair();
  const address = bs58.encode(keyPair.publicKey);
  const message = [
    buildSiwsMessage({
      domain: HOST,
      address,
      statement: "Sign in",
      uri: URI,
      chainId: SOLANA_CHAIN,
      nonce,
      issuedAt: new Date(),
    }),
    ...extraLines,
  ].join("\n");
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), keyPair.secretKey),
  );
  await validateAndConsumeSIWS(redis, message, signature, HOST);
}

/** Signs a SIWE message with the given extra timestamp lines appended. */
async function siwe(extraLines: string[]): Promise<void> {
  const redis = mockRedis();
  const nonce = await issueSiweNonce(redis, { uri: URI, chainId: EVM_CHAIN });
  const account = privateKeyToAccount(PRIVATE_KEY);
  const message = [
    `${HOST} wants you to sign in with your Ethereum account:`,
    account.address,
    "",
    "Sign in",
    "",
    `URI: ${URI}`,
    "Version: 1",
    `Chain ID: ${EVM_CHAIN}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    ...extraLines,
  ].join("\n");
  const signature = await account.signMessage({ message });
  await validateAndConsumeSIWE(redis, message, signature as `0x${string}`, HOST);
}

describe("SIWS message window fails closed on an unparseable timestamp", () => {
  test("a well-formed message with no timestamps is still accepted", async () => {
    await siws([]);
  });

  test("a future Expiration Time is accepted and a past one is rejected", async () => {
    await siws([`Expiration Time: ${future()}`]);
    await expect(siws([`Expiration Time: ${past()}`])).rejects.toThrow(/has expired/i);
  });

  test("an unparseable Expiration Time is rejected, not treated as no expiry", async () => {
    await expect(siws(["Expiration Time: not-a-date"])).rejects.toThrow(
      /Expiration Time is not a valid date/i,
    );
  });

  test("an unparseable Not Before is rejected, not treated as already valid", async () => {
    await expect(siws(["Not Before: not-a-date"])).rejects.toThrow(
      /Not Before is not a valid date/i,
    );
  });

  test("a plausible-looking but invalid calendar date is still rejected", async () => {
    // The shape parses as a string but not as a date; this is the realistic
    // malformed value, not obvious garbage.
    await expect(siws(["Expiration Time: 2026-13-45T99:99:99Z"])).rejects.toThrow(
      /Expiration Time is not a valid date/i,
    );
  });

  test("a future Not Before is still rejected as not-yet-valid", async () => {
    await expect(siws([`Not Before: ${future()}`])).rejects.toThrow(/not yet valid/i);
  });
});

describe("SIWE message window fails closed on an unparseable timestamp", () => {
  test("a well-formed message with no timestamps is still accepted", async () => {
    await siwe([]);
  });

  test("a future Expiration Time is accepted and a past one is rejected", async () => {
    await siwe([`Expiration Time: ${future()}`]);
    await expect(siwe([`Expiration Time: ${past()}`])).rejects.toThrow(/has expired/i);
  });

  test("an unparseable Expiration Time is rejected, not treated as no expiry", async () => {
    await expect(siwe(["Expiration Time: not-a-date"])).rejects.toThrow(
      /timestamp is not a valid date: Expiration Time/i,
    );
  });

  test("an unparseable Not Before is rejected, not treated as already valid", async () => {
    await expect(siwe(["Not Before: not-a-date"])).rejects.toThrow(
      /timestamp is not a valid date: Not Before/i,
    );
  });

  test("a future Not Before is still rejected as not-yet-valid", async () => {
    await expect(siwe([`Not Before: ${future()}`])).rejects.toThrow(/not yet valid/i);
  });
});
