import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { CompatibleRedis } from "@/lib/cache/redis-factory";
import { consumeNonce, issueNonce, validateSIWEMessage } from "@/lib/utils/siwe-helpers";

function buildSiweMessage(opts: { domain: string; address: string; nonce: string }): string {
  return [
    `${opts.domain} wants you to sign in with your Ethereum account:`,
    opts.address,
    "",
    "Sign in to Eliza Cloud",
    "",
    `URI: https://${opts.domain}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${opts.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

// Minimal in-memory mock that satisfies the bits issueNonce/consumeNonce use.
// Anything else throws — keeps the surface tight.
function makeMockRedis(): CompatibleRedis & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    setex: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    },
    getdel: async (key: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      store.delete(key);
      return v;
    },
  } as CompatibleRedis & { _store: Map<string, string> };
}

describe("siwe-helpers (smoke)", () => {
  test("issueNonce returns a 32-char hex and persists under siwe:nonce:{nonce}:v1", async () => {
    const r = makeMockRedis();
    const nonce = await issueNonce(r);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(r._store.size).toBe(1);
    const [key] = [...r._store.keys()];
    expect(key).toBe(`siwe:nonce:${nonce}:v1`);
  });

  test("consumeNonce returns true once, false on replay", async () => {
    const r = makeMockRedis();
    const nonce = await issueNonce(r);
    expect(await consumeNonce(r, nonce)).toBe(true);
    expect(await consumeNonce(r, nonce)).toBe(false);
    expect(r._store.size).toBe(0);
  });

  test("consumeNonce returns false for an unknown nonce", async () => {
    const r = makeMockRedis();
    expect(await consumeNonce(r, "deadbeef".repeat(4))).toBe(false);
  });

  test("each issueNonce call produces a unique nonce", async () => {
    const r = makeMockRedis();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(await issueNonce(r));
    expect(seen.size).toBe(50);
  });
});

describe("validateSIWEMessage", () => {
  test("accepts a valid signed message when expectedHost matches", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = buildSiweMessage({
      domain: "elizacloud.ai",
      address: account.address,
      nonce: "abc123def456abc1",
    });
    const signature = await account.signMessage({ message });

    const result = await validateSIWEMessage(message, signature, "elizacloud.ai");

    expect(result.address).toBe(account.address);
    expect(result.parsed.nonce).toBe("abc123def456abc1");
    expect(result.parsed.domain).toBe("elizacloud.ai");
  });

  test("rejects when expectedHost does not match parsed domain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = buildSiweMessage({
      domain: "evil.com",
      address: account.address,
      nonce: "abc123def456abc1",
    });
    const signature = await account.signMessage({ message });

    await expect(validateSIWEMessage(message, signature, "elizacloud.ai")).rejects.toThrow(
      "SIWE domain does not match app host: got evil.com, expected elizacloud.ai",
    );
  });

  test("rejects when signature does not match the address in the message", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const impersonated = privateKeyToAccount(generatePrivateKey());
    const message = buildSiweMessage({
      domain: "elizacloud.ai",
      address: impersonated.address,
      nonce: "abc123def456abc1",
    });
    const signature = await signer.signMessage({ message });

    await expect(validateSIWEMessage(message, signature, "elizacloud.ai")).rejects.toThrow(
      "SIWE signature invalid",
    );
  });
});
