/**
 * Wallet header auth payload-binding contract: the signed message commits to
 * method+path plus a SHA-256 of the canonical query and raw body, so a
 * captured header triple cannot be replayed with a rewritten body or query.
 * The legacy (pre-binding) message is accepted only when the request carries
 * no query and no body. Signature verification is real (viem); the cache and
 * user provisioning boundaries are mocked.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

const nonceStore = new Map<string, string>();

mock.module("../cache/client", () => ({
  cache: {
    isAvailable: () => true,
    setIfNotExists: async (key: string, value: string) => {
      if (nonceStore.has(key)) return false;
      nonceStore.set(key, value);
      return true;
    },
    get: async () => null,
    set: async () => {},
    del: async () => {},
  },
}));

mock.module("../services/wallet-signup", () => ({
  findOrCreateUserByWalletAddress: async (walletAddress: string) => ({
    user: {
      id: "user-1",
      wallet_address: walletAddress.toLowerCase(),
      is_active: true,
      organization_id: "org-1",
      organization: { id: "org-1", is_active: true },
    },
  }),
}));

mock.module("../utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

const { canonicalWalletAuthQuery, verifyWalletSignature } = await import("./wallet-auth");

const account = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface SignedRequestInit {
  method?: string;
  query?: string;
  body?: string;
  /** Sign the pre-payload-binding legacy message instead. */
  legacy?: boolean;
  /** Override the exact canonical payload the signature commits to. */
  signedPayload?: { canonicalQuery: string; body: string };
  /** Fresh timestamp per request so distinct cases never share a nonce. */
  timestamp?: number;
}

async function signedRequest(path: string, init: SignedRequestInit = {}): Promise<Request> {
  const method = init.method ?? "POST";
  const query = init.query ?? "";
  const body = init.body ?? "";
  const timestamp = init.timestamp ?? Date.now();
  const url = `https://api.eliza.app${path}${query}`;

  const canonical = init.signedPayload ?? {
    canonicalQuery: canonicalWalletAuthQuery(new URL(url)),
    body,
  };
  const base = `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: ${method}\nPath: ${path}`;
  const message = init.legacy
    ? base
    : `${base}\nPayload-SHA256: ${await sha256Hex(`${canonical.canonicalQuery}\n${canonical.body}`)}`;
  const signature = await account.signMessage({ message });

  return new Request(url, {
    method,
    headers: {
      "X-Wallet-Address": account.address,
      "X-Timestamp": String(timestamp),
      "X-Wallet-Signature": signature,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
}

beforeEach(() => {
  nonceStore.clear();
});

describe("canonicalWalletAuthQuery", () => {
  test("sorts decoded pairs by key then value", () => {
    const url = new URL("https://api.eliza.app/x?b=2&a=1&b=1&a=%20");
    expect(canonicalWalletAuthQuery(url)).toBe("a= &a=1&b=1&b=2");
  });

  test("is empty when there is no query string", () => {
    expect(canonicalWalletAuthQuery(new URL("https://api.eliza.app/x"))).toBe("");
  });
});

describe("verifyWalletSignature payload binding", () => {
  test("accepts a payload-bound signature and returns the user", async () => {
    const request = await signedRequest("/api/v1/credits/topup", {
      body: JSON.stringify({ walletAddress: account.address }),
    });
    const user = await verifyWalletSignature(request);
    expect(user?.id).toBe("user-1");
  });

  test("rejects the same signature replayed with a rewritten body", async () => {
    const timestamp = Date.now();
    const honest = await signedRequest("/api/v1/credits/topup", {
      body: JSON.stringify({ ref: "honest" }),
      timestamp,
    });
    await verifyWalletSignature(honest);

    // Attacker captures the header triple and replays it against a different
    // body on the same path inside the freshness window.
    const headers = new Headers(honest.headers);
    const replayed = new Request("https://api.eliza.app/api/v1/credits/topup", {
      method: "POST",
      headers,
      body: JSON.stringify({ ref: "attacker-rewrite" }),
    });
    await expect(verifyWalletSignature(replayed)).rejects.toThrow("Invalid wallet signature");
  });

  test("rejects the same signature replayed with a rewritten query", async () => {
    const timestamp = Date.now();
    const honest = await signedRequest("/api/v1/wallets", {
      method: "GET",
      query: "?limit=10",
      timestamp,
    });
    await verifyWalletSignature(honest);

    const replayed = new Request("https://api.eliza.app/api/v1/wallets?limit=500", {
      method: "GET",
      headers: new Headers(honest.headers),
    });
    await expect(verifyWalletSignature(replayed)).rejects.toThrow("Invalid wallet signature");
  });

  test("canonical query makes parameter order irrelevant", async () => {
    const request = await signedRequest("/api/v1/wallets", {
      method: "GET",
      query: "?b=2&a=1",
    });
    // Same parameters, different order — the canonical hash is identical.
    const reordered = new Request("https://api.eliza.app/api/v1/wallets?a=1&b=2", {
      method: "GET",
      headers: new Headers(request.headers),
    });
    const user = await verifyWalletSignature(reordered);
    expect(user?.id).toBe("user-1");
  });

  test("accepts a legacy signature only when there is no query and no body", async () => {
    const request = await signedRequest("/api/v1/user/wallets", {
      method: "GET",
      legacy: true,
    });
    const user = await verifyWalletSignature(request);
    expect(user?.id).toBe("user-1");
  });

  test("rejects a legacy signature when the request carries a body", async () => {
    const request = await signedRequest("/api/v1/credits/topup", {
      body: JSON.stringify({ walletAddress: account.address }),
      legacy: true,
    });
    await expect(verifyWalletSignature(request)).rejects.toThrow("Invalid wallet signature");
  });

  test("honors the caller-supplied exact body bytes (pre-consumed streams)", async () => {
    const rawBody = JSON.stringify({ walletAddress: account.address });
    const timestamp = Date.now();
    const canonical = canonicalWalletAuthQuery(new URL("https://api.eliza.app/api/v1/topup/10"));
    const payloadHash = await sha256Hex(`${canonical}\n${rawBody}`);
    const message = `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: POST\nPath: /api/v1/topup/10\nPayload-SHA256: ${payloadHash}`;
    const signature = await account.signMessage({ message });

    // Simulate the topup handler: the body was already read for JSON parsing,
    // so the Request handed to the verifier carries only headers.
    const headersOnly = new Request("https://api.eliza.app/api/v1/topup/10", {
      method: "POST",
      headers: {
        "X-Wallet-Address": account.address,
        "X-Timestamp": String(timestamp),
        "X-Wallet-Signature": signature,
        "content-type": "application/json",
      },
    });
    const user = await verifyWalletSignature(headersOnly, {
      bodyText: rawBody,
    });
    expect(user?.id).toBe("user-1");
  });
});
