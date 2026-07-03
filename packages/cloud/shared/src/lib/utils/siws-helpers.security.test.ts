/**
 * L7 (#12229): SIWS validation binds the signed `uri` + `chainId` to the values
 * the server issued with the nonce. A message on the correct domain with a valid
 * ed25519 signature but a substituted uri/chainId is rejected.
 *
 * The signature exercised is a REAL ed25519 signature (tweetnacl) over the REAL
 * SIWS message; only the nonce store is an in-memory stand-in for Redis.
 */

import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { CacheKeys } from "../cache/keys";
import type { CompatibleRedis } from "../cache/redis-factory";
import { buildSiwsMessage, issueSiwsNonce, validateAndConsumeSIWS } from "./siws-helpers";

const HOST = "app.example.com";
const URI = "https://app.example.com";
const CHAIN = "solana:mainnet";

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
      const v = store.get(key) ?? null;
      store.delete(key);
      return v;
    },
  } as unknown as CompatibleRedis;
}

function signSiws(params: { nonce: string; uri: string; chainId: string; domain: string }) {
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  const message = buildSiwsMessage({
    domain: params.domain,
    address,
    statement: "Sign in",
    uri: params.uri,
    chainId: params.chainId,
    nonce: params.nonce,
    issuedAt: new Date(),
  });
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  return { message, signature: bs58.encode(sig), address };
}

describe("L7 SIWS uri/chainId binding", () => {
  test("accepts a message whose uri + chainId match the issued nonce", async () => {
    const redis = mockRedis();
    const nonce = await issueSiwsNonce(redis, { uri: URI, chainId: CHAIN });
    const { message, signature, address } = signSiws({
      nonce,
      uri: URI,
      chainId: CHAIN,
      domain: HOST,
    });
    const result = await validateAndConsumeSIWS(redis, message, signature, HOST);
    expect(result.address).toBe(address);
  });

  test("rejects a valid signature that signed a different chainId", async () => {
    const redis = mockRedis();
    const nonce = await issueSiwsNonce(redis, { uri: URI, chainId: CHAIN });
    const { message, signature } = signSiws({
      nonce,
      uri: URI,
      chainId: "solana:devnet",
      domain: HOST,
    });
    await expect(validateAndConsumeSIWS(redis, message, signature, HOST)).rejects.toThrow(
      /chainId does not match/i,
    );
  });

  test("rejects a valid signature that signed a different uri", async () => {
    const redis = mockRedis();
    const nonce = await issueSiwsNonce(redis, { uri: URI, chainId: CHAIN });
    const { message, signature } = signSiws({
      nonce,
      uri: "https://evil.example.com",
      chainId: CHAIN,
      domain: HOST,
    });
    await expect(validateAndConsumeSIWS(redis, message, signature, HOST)).rejects.toThrow(
      /uri does not match/i,
    );
  });

  test("legacy binding-less nonce ('1') skips the uri/chainId assertions", async () => {
    const redis = mockRedis();
    const nonce = "deadbeef";
    await redis.setex(CacheKeys.siws.nonce(nonce), 300, "1");
    const { message, signature } = signSiws({
      nonce,
      uri: "https://anything",
      chainId: "solana:testnet",
      domain: HOST,
    });
    const result = await validateAndConsumeSIWS(redis, message, signature, HOST);
    expect(result.address).toBeTruthy();
  });
});
