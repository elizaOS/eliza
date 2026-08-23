/**
 * Deterministic unit coverage of the cloud e2e wallet-login helpers:
 * SIWE session passthrough, SeededUser adaptation, and privileged elevation
 * after a real handshake. Drives the real module through a fetch shim that
 * runs viem signature validation; repository writes are captured at the
 * cloud-shared boundary. Run with
 * `bun test packages/cloud/e2e/src/helpers/wallet-login.test.ts` (the
 * package's Playwright lane matches only `tests/`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { validateSIWEMessage } from "@elizaos/cloud-shared/lib/utils/siwe-helpers";
import type { SiweTestLoginResult } from "./wallet-login";

type UserUpdate = { id: string; data: Record<string, unknown> };
type OrgUpdate = { id: string; data: Record<string, unknown> };

const userUpdates: UserUpdate[] = [];
const orgUpdates: OrgUpdate[] = [];

let userUpdateImpl: (
  id: string,
  data: Record<string, unknown>,
) => Promise<unknown> = async (id, data) => {
  userUpdates.push({ id, data });
  return { id, ...data };
};

let orgUpdateImpl: (
  id: string,
  data: Record<string, unknown>,
) => Promise<unknown> = async (id, data) => {
  orgUpdates.push({ id, data });
  return { id, ...data };
};

mock.module("@elizaos/cloud-shared/db/repositories/users", () => ({
  usersRepository: {
    update: (id: string, data: Record<string, unknown>) =>
      userUpdateImpl(id, data),
  },
}));

mock.module("@elizaos/cloud-shared/db/repositories/organizations", () => ({
  organizationsRepository: {
    update: (id: string, data: Record<string, unknown>) =>
      orgUpdateImpl(id, data),
  },
}));

const { asSeededUser, loginAsSeededUser, loginWithTestWallet } = await import(
  "./wallet-login"
);
const walletLogin = await import("./wallet-login");

const NONCE_DOMAIN = "localhost:3000";
const NONCE_URI = "http://localhost:3000";
const HARDHAT_ACCOUNT1_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const HARDHAT_ACCOUNT1_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SESSION_API_KEY = "eliza_test_account_key_0123456789";
const SESSION_USER_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ORG_ID = "00000000-0000-4000-8000-000000000002";

type RecordedFetch = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
};

type SiweShimOptions = {
  nonceStatus?: number;
  nonceText?: string;
  verifyStatus?: number;
  verifyBody?: unknown;
  tamper?: boolean;
};

const originalFetch = globalThis.fetch;

function headerRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key.toLowerCase()] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function installSiweFetch(opts: SiweShimOptions = {}): RecordedFetch[] {
  const calls: RecordedFetch[] = [];
  const issuedNonces = new Set<string>();

  globalThis.fetch = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const recorded: RecordedFetch = {
      url,
      method: init?.method,
      headers: headerRecord(init?.headers),
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(recorded);

    if (url.includes("/api/auth/siwe/nonce")) {
      if (opts.nonceStatus !== undefined && opts.nonceStatus !== 200) {
        return new Response(opts.nonceText ?? "nonce unavailable", {
          status: opts.nonceStatus,
        });
      }
      const nonce = `n${issuedNonces.size}${Math.random().toString(16).slice(2)}`;
      issuedNonces.add(nonce);
      return new Response(
        JSON.stringify({
          nonce,
          domain: NONCE_DOMAIN,
          uri: NONCE_URI,
          chainId: 1,
          version: "1",
          statement: "Sign in to Eliza Cloud",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/api/auth/siwe/verify")) {
      if (opts.verifyBody !== undefined) {
        return new Response(JSON.stringify(opts.verifyBody), {
          status: opts.verifyStatus ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (opts.verifyStatus !== undefined && opts.verifyStatus !== 200) {
        return new Response("verify unavailable", {
          status: opts.verifyStatus,
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        message: string;
        signature: `0x${string}`;
      };
      const message = opts.tamper
        ? body.message.replace(/Nonce: \w+/, "Nonce: forged000")
        : body.message;
      try {
        const { address } = await validateSIWEMessage(
          message,
          body.signature,
          NONCE_DOMAIN,
        );
        return new Response(
          JSON.stringify({
            apiKey: SESSION_API_KEY,
            address,
            isNewAccount: true,
            user: {
              id: SESSION_USER_ID,
              wallet_address: address,
              organization_id: SESSION_ORG_ID,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch {
        return new Response(
          JSON.stringify({ error: "SIWE verification failed" }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return calls;
}

function sessionLogin(
  overrides: Partial<SiweTestLoginResult> = {},
): SiweTestLoginResult {
  return {
    apiKey: SESSION_API_KEY,
    address: HARDHAT_ACCOUNT1_ADDRESS,
    userId: SESSION_USER_ID,
    organizationId: SESSION_ORG_ID,
    isNewAccount: true,
    privateKey: HARDHAT_ACCOUNT1_KEY,
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  userUpdates.length = 0;
  orgUpdates.length = 0;
  userUpdateImpl = async (id, data) => {
    userUpdates.push({ id, data });
    return { id, ...data };
  };
  orgUpdateImpl = async (id, data) => {
    orgUpdates.push({ id, data });
    return { id, ...data };
  };
});

describe("wallet-login exports", () => {
  test("exports the three runtime helpers and re-exports no extra values", () => {
    expect(Object.keys(walletLogin).sort()).toEqual([
      "asSeededUser",
      "loginAsSeededUser",
      "loginWithTestWallet",
    ]);
    expect(walletLogin.asSeededUser).toBe(asSeededUser);
    expect(walletLogin.loginAsSeededUser).toBe(loginAsSeededUser);
    expect(walletLogin.loginWithTestWallet).toBe(loginWithTestWallet);
  });

  test("does not expose a queue, comparator, capacity, or item-removal API", () => {
    const record = walletLogin as unknown as Record<string, unknown>;
    expect("queue" in record).toBe(false);
    expect("capacity" in record).toBe(false);
    expect("comparator" in record).toBe(false);
    expect("remove" in record).toBe(false);
  });
});

describe("asSeededUser", () => {
  test("maps ids and apiKey, blanks email, and prefixes stewardUserId with wallet-", () => {
    expect(asSeededUser(sessionLogin())).toEqual({
      userId: SESSION_USER_ID,
      organizationId: SESSION_ORG_ID,
      stewardUserId: `wallet-${HARDHAT_ACCOUNT1_ADDRESS.toLowerCase()}`,
      email: "",
      apiKey: SESSION_API_KEY,
    });
  });

  test("lowercases a mixed-case checksum address in stewardUserId only", () => {
    const seeded = asSeededUser(sessionLogin());
    expect(seeded.stewardUserId).toBe(
      "wallet-0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    );
    expect(seeded.userId).toBe(SESSION_USER_ID);
    expect(seeded.organizationId).toBe(SESSION_ORG_ID);
  });

  test("leaves an already-lowercase address lowercase", () => {
    const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const seeded = asSeededUser(sessionLogin({ address }));
    expect(seeded.stewardUserId).toBe(`wallet-${address}`);
  });

  test("passes userId, organizationId, and apiKey through without rewriting case", () => {
    const seeded = asSeededUser(
      sessionLogin({
        userId: "User-Mixed",
        organizationId: "Org-Mixed",
        apiKey: "Key-Mixed",
      }),
    );
    expect(seeded.userId).toBe("User-Mixed");
    expect(seeded.organizationId).toBe("Org-Mixed");
    expect(seeded.apiKey).toBe("Key-Mixed");
  });

  test("does not copy address, isNewAccount, or privateKey onto SeededUser", () => {
    const seeded = asSeededUser(sessionLogin({ isNewAccount: false }));
    expect(seeded).not.toHaveProperty("address");
    expect(seeded).not.toHaveProperty("isNewAccount");
    expect(seeded).not.toHaveProperty("privateKey");
    expect(Object.keys(seeded).sort()).toEqual([
      "apiKey",
      "email",
      "organizationId",
      "stewardUserId",
      "userId",
    ]);
  });

  test("empty address yields the wallet- prefix with nothing after it", () => {
    expect(asSeededUser(sessionLogin({ address: "" })).stewardUserId).toBe(
      "wallet-",
    );
  });

  test("throws when address is missing because toLowerCase is required", () => {
    expect(() =>
      asSeededUser(
        sessionLogin({
          address: undefined as unknown as string,
        }),
      ),
    ).toThrow();
  });
});

describe("loginWithTestWallet", () => {
  test("completes a real SIWE handshake and returns the session", async () => {
    installSiweFetch();
    const session = await loginWithTestWallet(NONCE_URI);

    expect(session.apiKey).toBe(SESSION_API_KEY);
    expect(session.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(session.isNewAccount).toBe(true);
    expect(session.userId).toBe(SESSION_USER_ID);
    expect(session.organizationId).toBe(SESSION_ORG_ID);
    expect(session.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  test("signs in deterministically when a private key is supplied", async () => {
    installSiweFetch();
    const a = await loginWithTestWallet(NONCE_URI, HARDHAT_ACCOUNT1_KEY);
    const b = await loginWithTestWallet(NONCE_URI, HARDHAT_ACCOUNT1_KEY);
    expect(a.address).toBe(b.address);
    expect(a.address).toBe(HARDHAT_ACCOUNT1_ADDRESS);
    expect(a.privateKey).toBe(HARDHAT_ACCOUNT1_KEY);
    expect(b.privateKey).toBe(HARDHAT_ACCOUNT1_KEY);
  });

  test("omitting the private key mints a fresh wallet each call", async () => {
    installSiweFetch();
    const a = await loginWithTestWallet(NONCE_URI);
    const b = await loginWithTestWallet(NONCE_URI);
    expect(a.address).not.toBe(b.address);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  test("strips a trailing slash on baseUrl before requesting the nonce", async () => {
    const calls = installSiweFetch();
    await loginWithTestWallet(`${NONCE_URI}/`);
    expect(calls[0]?.url).toBe(`${NONCE_URI}/api/auth/siwe/nonce?chainId=1`);
    expect(calls[1]?.url).toBe(`${NONCE_URI}/api/auth/siwe/verify`);
  });

  test("requests the default chainId=1 nonce and posts origin + JSON verify", async () => {
    const calls = installSiweFetch();
    await loginWithTestWallet(NONCE_URI, HARDHAT_ACCOUNT1_KEY);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${NONCE_URI}/api/auth/siwe/nonce?chainId=1`);
    expect(calls[0]?.headers.accept).toBe("application/json");

    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.headers["content-type"]).toBe("application/json");
    expect(calls[1]?.headers.origin).toBe(NONCE_URI);
    const posted = JSON.parse(calls[1]?.body ?? "{}") as {
      message: string;
      signature: string;
    };
    expect(posted.message).toContain(HARDHAT_ACCOUNT1_ADDRESS);
    expect(posted.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  test("throws on a failed nonce request and never hits verify", async () => {
    const calls = installSiweFetch({ nonceStatus: 503, nonceText: "warming" });
    await expect(loginWithTestWallet(NONCE_URI)).rejects.toThrow(
      /SIWE nonce request failed: 503 warming/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/auth/siwe/nonce");
  });

  test("throws on a rejected signature and does not return a dead key", async () => {
    installSiweFetch({ tamper: true });
    await expect(loginWithTestWallet(NONCE_URI)).rejects.toThrow(
      /SIWE verify failed: 401/,
    );
  });

  test("throws on a non-OK verify status", async () => {
    installSiweFetch({ verifyStatus: 500 });
    await expect(loginWithTestWallet(NONCE_URI)).rejects.toThrow(
      /SIWE verify failed: 500 verify unavailable/,
    );
  });

  test("throws when verify omits apiKey, user id, or organization id", async () => {
    installSiweFetch({
      verifyBody: {
        apiKey: "",
        address: HARDHAT_ACCOUNT1_ADDRESS,
        isNewAccount: true,
        user: { id: SESSION_USER_ID, organization_id: SESSION_ORG_ID },
      },
    });
    await expect(loginWithTestWallet(NONCE_URI)).rejects.toThrow(
      /SIWE verify returned an incomplete session/,
    );

    installSiweFetch({
      verifyBody: {
        apiKey: SESSION_API_KEY,
        address: HARDHAT_ACCOUNT1_ADDRESS,
        isNewAccount: true,
        user: { organization_id: SESSION_ORG_ID },
      },
    });
    await expect(loginWithTestWallet(NONCE_URI)).rejects.toThrow(
      /SIWE verify returned an incomplete session/,
    );

    installSiweFetch({
      verifyBody: {
        apiKey: SESSION_API_KEY,
        address: HARDHAT_ACCOUNT1_ADDRESS,
        isNewAccount: true,
        user: { id: SESSION_USER_ID },
      },
    });
    await expect(loginWithTestWallet(NONCE_URI)).rejects.toThrow(
      /SIWE verify returned an incomplete session/,
    );
  });
});

describe("loginAsSeededUser", () => {
  test("returns an elevated SeededUser from the real SIWE session", async () => {
    installSiweFetch();
    const seeded = await loginAsSeededUser(NONCE_URI, HARDHAT_ACCOUNT1_KEY);
    const normalized = HARDHAT_ACCOUNT1_ADDRESS.toLowerCase();

    expect(seeded).toEqual({
      userId: SESSION_USER_ID,
      organizationId: SESSION_ORG_ID,
      stewardUserId: `wallet:evm:${normalized}`,
      email: `${normalized}@e2e.test`,
      apiKey: SESSION_API_KEY,
    });
  });

  test("uses wallet:evm: steward ids, not the asSeededUser wallet- prefix", async () => {
    installSiweFetch();
    const loginShaped = asSeededUser(sessionLogin());
    const elevated = await loginAsSeededUser(NONCE_URI, HARDHAT_ACCOUNT1_KEY);
    expect(loginShaped.stewardUserId.startsWith("wallet-")).toBe(true);
    expect(elevated.stewardUserId.startsWith("wallet:evm:")).toBe(true);
    expect(elevated.stewardUserId).not.toBe(loginShaped.stewardUserId);
    expect(elevated.email).not.toBe(loginShaped.email);
  });

  test("elevates the user to admin with a verified address-derived email and name", async () => {
    installSiweFetch();
    await loginAsSeededUser(NONCE_URI, HARDHAT_ACCOUNT1_KEY);
    const normalized = HARDHAT_ACCOUNT1_ADDRESS.toLowerCase();

    expect(userUpdates).toEqual([
      {
        id: SESSION_USER_ID,
        data: {
          email: `${normalized}@e2e.test`,
          email_verified: true,
          name: `wallet-${normalized.slice(2, 10)}`,
          role: "admin",
        },
      },
    ]);
    expect(userUpdates[0]?.data.name).toBe("wallet-70997970");
  });

  test("funds the org at 1000.000000 and copies billing_email from the user", async () => {
    installSiweFetch();
    await loginAsSeededUser(NONCE_URI, HARDHAT_ACCOUNT1_KEY);
    const normalized = HARDHAT_ACCOUNT1_ADDRESS.toLowerCase();

    expect(orgUpdates).toEqual([
      {
        id: SESSION_ORG_ID,
        data: {
          credit_balance: "1000.000000",
          billing_email: `${normalized}@e2e.test`,
        },
      },
    ]);
  });

  test("writes the user row before the organization row", async () => {
    const order: string[] = [];
    userUpdateImpl = async (id, data) => {
      order.push("user");
      userUpdates.push({ id, data });
      return { id, ...data };
    };
    orgUpdateImpl = async (id, data) => {
      order.push("org");
      orgUpdates.push({ id, data });
      return { id, ...data };
    };
    installSiweFetch();
    await loginAsSeededUser(NONCE_URI, HARDHAT_ACCOUNT1_KEY);
    expect(order).toEqual(["user", "org"]);
  });

  test("does not write repositories when SIWE verify fails", async () => {
    installSiweFetch({ tamper: true });
    await expect(loginAsSeededUser(NONCE_URI)).rejects.toThrow(
      /SIWE verify failed/,
    );
    expect(userUpdates).toEqual([]);
    expect(orgUpdates).toEqual([]);
  });

  test("does not write the org when user elevation throws", async () => {
    userUpdateImpl = async () => {
      throw new Error("user update failed");
    };
    installSiweFetch();
    await expect(
      loginAsSeededUser(NONCE_URI, HARDHAT_ACCOUNT1_KEY),
    ).rejects.toThrow("user update failed");
    expect(orgUpdates).toEqual([]);
  });

  test("omitting the private key still elevates the minted wallet account", async () => {
    installSiweFetch();
    const seeded = await loginAsSeededUser(NONCE_URI);
    expect(seeded.userId).toBe(SESSION_USER_ID);
    expect(seeded.organizationId).toBe(SESSION_ORG_ID);
    expect(seeded.email).toMatch(/^0x[0-9a-f]{40}@e2e\.test$/);
    expect(seeded.stewardUserId).toMatch(/^wallet:evm:0x[0-9a-f]{40}$/);
    expect(userUpdates).toHaveLength(1);
    expect(orgUpdates).toHaveLength(1);
  });
});
