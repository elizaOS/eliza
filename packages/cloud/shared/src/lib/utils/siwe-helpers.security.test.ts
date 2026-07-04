/**
 * L7 (#12229): SIWE validation binds the signed `uri` + `chainId` to the values
 * the server issued alongside the nonce (EIP-4361 completeness). A message on
 * the correct domain with a valid signature but a substituted uri/chainId is
 * rejected.
 *
 * The signature exercised is a REAL secp256k1 signature (viem) over the REAL
 * EIP-4361 message; only the nonce store is an in-memory stand-in for Redis.
 */

import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { CacheKeys } from "../cache/keys";
import type { CompatibleRedis } from "../cache/redis-factory";
import { issueNonce, validateAndConsumeSIWE } from "./siwe-helpers";

const HOST = "app.example.com";
const URI = "https://app.example.com";

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

async function signMessage(params: {
  nonce: string;
  chainId: number;
  uri: string;
  domain: string;
}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = createSiweMessage({
    address: account.address,
    chainId: params.chainId,
    domain: params.domain,
    nonce: params.nonce,
    uri: params.uri,
    version: "1",
    statement: "Sign in",
    issuedAt: new Date(),
  });
  const signature = await account.signMessage({ message });
  return { message, signature, address: account.address };
}

describe("L7 SIWE uri/chainId binding", () => {
  test("accepts a message whose uri + chainId match the issued nonce", async () => {
    const redis = mockRedis();
    const nonce = await issueNonce(redis, { uri: URI, chainId: 1 });
    const { message, signature } = await signMessage({ nonce, chainId: 1, uri: URI, domain: HOST });
    const result = await validateAndConsumeSIWE(redis, message, signature, HOST);
    expect(result.address).toBeTruthy();
  });

  test("rejects a valid signature that signed a different chainId", async () => {
    const redis = mockRedis();
    const nonce = await issueNonce(redis, { uri: URI, chainId: 1 });
    // Same domain, valid signature, but the user signed chainId 137 (Polygon).
    const { message, signature } = await signMessage({
      nonce,
      chainId: 137,
      uri: URI,
      domain: HOST,
    });
    await expect(validateAndConsumeSIWE(redis, message, signature, HOST)).rejects.toThrow(
      /chainId does not match/i,
    );
  });

  test("rejects a valid signature that signed a different uri", async () => {
    const redis = mockRedis();
    const nonce = await issueNonce(redis, { uri: URI, chainId: 1 });
    const { message, signature } = await signMessage({
      nonce,
      chainId: 1,
      uri: "https://evil.example.com",
      domain: HOST,
    });
    await expect(validateAndConsumeSIWE(redis, message, signature, HOST)).rejects.toThrow(
      /uri does not match/i,
    );
  });

  test("does not burn the nonce on a uri/chainId mismatch (client can retry)", async () => {
    const redis = mockRedis();
    const nonce = await issueNonce(redis, { uri: URI, chainId: 1 });
    const bad = await signMessage({ nonce, chainId: 137, uri: URI, domain: HOST });
    await expect(validateAndConsumeSIWE(redis, bad.message, bad.signature, HOST)).rejects.toThrow();
    // The nonce is still present; a corrected message succeeds.
    const good = await signMessage({ nonce, chainId: 1, uri: URI, domain: HOST });
    const ok = await validateAndConsumeSIWE(redis, good.message, good.signature, HOST);
    expect(ok.address).toBeTruthy();
  });

  test("legacy binding-less nonce ('1') skips the uri/chainId assertions", async () => {
    const redis = mockRedis();
    // Simulate an in-flight nonce issued by the previous code path.
    const nonce = "deadbeef";
    await redis.setex(CacheKeys.siwe.nonce(nonce), 300, "1");
    const { message, signature } = await signMessage({
      nonce,
      chainId: 999,
      uri: "https://anything",
      domain: HOST,
    });
    const result = await validateAndConsumeSIWE(redis, message, signature, HOST);
    expect(result.address).toBeTruthy();
  });
});
