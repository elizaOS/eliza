/** Verifies buildSiweMessage through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * The SIWE wallet login (#13377), driven through a REAL signing wallet: the
 * e2e harness provider from platform/e2e-wallet.ts backed by a throwaway viem
 * account. Only the network boundary (fetch to the cloud API) is doubled —
 * the nonce/message/signature round trip is genuine, and the test recovers
 * the signer address from the produced signature to prove the handshake would
 * verify server-side.
 */

import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isStoreBuild: vi.fn(() => false),
}));

vi.mock("../build-variant", () => ({
  isStoreBuild: mocks.isStoreBuild,
}));

vi.mock("@elizaos/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  writeStoredStewardToken: (token: string) => {
    window.localStorage.setItem("steward_session_token", token);
  },
}));

import {
  E2E_WALLET_AUTOLOGIN_STORAGE_KEY,
  E2E_WALLET_KEY_STORAGE_KEY,
  installE2eWalletIfRequested,
  isE2eWalletInstallAllowed,
  isE2eWalletWebHostnameAllowed,
} from "../platform/e2e-wallet";
import {
  buildSiweMessage,
  getInjectedEthereumProvider,
  isSupportedLoginChainId,
  readWalletChainId,
  SUPPORTED_SIWE_LOGIN_CHAIN_IDS,
  siweLoginWithInjectedWallet,
} from "./cloud-siwe-login";

const PRIVATE_KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);

/** The harness e2e wallet reports Base mainnet (8453) as eth_chainId (#18458). */
const HARNESS_CHAIN_ID = 8453;

const NONCE_RESPONSE = {
  nonce: "abcDEF123456",
  domain: "elizacloud.ai",
  uri: "https://elizacloud.ai",
  version: "1",
  statement: "Sign in to Eliza Cloud",
  chainId: HARNESS_CHAIN_ID,
};

function mockFetch(): {
  calls: Array<{ url: string; init?: RequestInit }>;
  verified: { message?: string; signature?: string };
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const verified: { message?: string; signature?: string } = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/api/auth/siwe/nonce")) {
        return new Response(JSON.stringify(NONCE_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/siwe/verify")) {
        const body = JSON.parse(String(init?.body)) as {
          message: string;
          signature: string;
        };
        verified.message = body.message;
        verified.signature = body.signature;
        return new Response(
          JSON.stringify({ apiKey: "eliza_test_api_key", address: "0x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return { calls, verified };
}

beforeEach(() => {
  mocks.isStoreBuild.mockReturnValue(false);
  window.localStorage.clear();
  Reflect.deleteProperty(window, "ethereum");
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "ethereum");
});

describe("buildSiweMessage", () => {
  it("emits the canonical EIP-4361 layout with a statement", () => {
    const message = buildSiweMessage({
      domain: "elizacloud.ai",
      address: ACCOUNT.address,
      statement: "Sign in to Eliza Cloud",
      uri: "https://elizacloud.ai",
      version: "1",
      chainId: HARNESS_CHAIN_ID,
      nonce: "abc",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(message).toBe(
      [
        "elizacloud.ai wants you to sign in with your Ethereum account:",
        ACCOUNT.address,
        "",
        "Sign in to Eliza Cloud",
        "",
        "URI: https://elizacloud.ai",
        "Version: 1",
        `Chain ID: ${HARNESS_CHAIN_ID}`,
        "Nonce: abc",
        "Issued At: 2026-01-01T00:00:00.000Z",
      ].join("\n"),
    );
  });

  it("omits the statement block entirely when absent", () => {
    const message = buildSiweMessage({
      domain: "d",
      address: ACCOUNT.address,
      uri: "u",
      version: "1",
      chainId: 1,
      nonce: "n",
      issuedAt: "t",
    });
    expect(message).not.toContain("\n\n\n");
    expect(message.split("\n")[3]).toBe("URI: u");
  });
});

describe("e2e wallet + SIWE login", () => {
  it("installs only when the harness key is seeded", async () => {
    expect(isE2eWalletInstallAllowed()).toBe(true);
    expect(await installE2eWalletIfRequested()).toBe(false);
    expect(getInjectedEthereumProvider()).toBeNull();

    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    expect(await installE2eWalletIfRequested()).toBe(true);
    const provider = getInjectedEthereumProvider();
    expect(provider?.isElizaE2eWallet).toBe(true);
    expect(await provider?.request({ method: "eth_accounts" })).toEqual([
      ACCOUNT.address,
    ]);
  });

  it("rejects deployed web origins even when a harness key is present", () => {
    expect(isE2eWalletWebHostnameAllowed("app.elizacloud.ai")).toBe(false);
    expect(isE2eWalletWebHostnameAllowed("elizacloud.ai")).toBe(false);
  });

  it("keeps localhost web e2e eligible", () => {
    expect(isE2eWalletWebHostnameAllowed("127.0.0.1")).toBe(true);
    expect(isE2eWalletWebHostnameAllowed("localhost")).toBe(true);
    expect(isE2eWalletInstallAllowed()).toBe(true);
  });

  it("keeps the harness wallet inert on store builds even when localStorage is seeded", async () => {
    mocks.isStoreBuild.mockReturnValue(true);
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);

    expect(isE2eWalletInstallAllowed()).toBe(false);
    expect(await installE2eWalletIfRequested()).toBe(false);
    expect(getInjectedEthereumProvider()).toBeNull();
  });

  it("never overwrites an already-injected wallet", async () => {
    const sentinel = { request: async () => [] };
    (window as { ethereum?: unknown }).ethereum = sentinel;
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    expect(await installE2eWalletIfRequested()).toBe(false);
    expect((window as { ethereum?: unknown }).ethereum).toBe(sentinel);
  });

  it("ignores Phantom's window.ethereum injection (never SIWE with Phantom)", () => {
    // Phantom multichain-injects window.ethereum with isPhantom:true; treating
    // it as an EVM SIWE provider pops Phantom on a non-wallet sign-in (the
    // "picked Google, got Phantom" bug). It must read as no injected provider.
    (window as { ethereum?: unknown }).ethereum = {
      isPhantom: true,
      request: async () => [],
    };
    expect(getInjectedEthereumProvider()).toBeNull();
  });

  it("returns a genuine (non-Phantom) injected EVM provider", () => {
    const metamask = { isMetaMask: true, request: async () => [] };
    (window as { ethereum?: unknown }).ethereum = metamask;
    expect(getInjectedEthereumProvider()).toBe(metamask);
  });

  it("completes the full SIWE handshake with a REAL recoverable signature and stores the session", async () => {
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    await installE2eWalletIfRequested();
    const { calls, verified } = mockFetch();
    const tokenSync = vi.fn();
    window.addEventListener("steward-token-sync", tokenSync, { once: true });

    const apiKey = await siweLoginWithInjectedWallet("https://api.test/");
    expect(apiKey).toBe("eliza_test_api_key");
    expect(window.localStorage.getItem("steward_session_token")).toBe(
      "eliza_test_api_key",
    );
    expect(tokenSync).toHaveBeenCalledTimes(1);

    // The nonce request binds the wallet's ACTUAL connected chain (#18458):
    // the harness wallet reports Base (8453), so the query string must carry it.
    const nonceCall = calls.find((c) => c.url.includes("/api/auth/siwe/nonce"));
    expect(nonceCall?.url).toContain(`chainId=${HARNESS_CHAIN_ID}`);

    // The signed message embeds the server's nonce/domain AND the wallet chain
    // (not a stale mainnet default), and the signature genuinely recovers to
    // the wallet address — exactly what the cloud API's verify endpoint checks.
    expect(verified.message).toContain(`Nonce: ${NONCE_RESPONSE.nonce}`);
    expect(verified.message).toContain(`Chain ID: ${HARNESS_CHAIN_ID}`);
    expect(verified.message).not.toContain("Chain ID: 1");
    expect(verified.message).toContain(ACCOUNT.address);
    expect(
      await verifyMessage({
        address: ACCOUNT.address,
        message: verified.message as string,
        signature: verified.signature as `0x${string}`,
      }),
    ).toBe(true);
  });

  it("auto-login at install time stores the session without any caller", async () => {
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    window.localStorage.setItem(E2E_WALLET_AUTOLOGIN_STORAGE_KEY, "1");
    mockFetch();

    await installE2eWalletIfRequested();
    expect(window.localStorage.getItem("steward_session_token")).toBe(
      "eliza_test_api_key",
    );
  });

  it("returns null (falls through) when no provider is injected", async () => {
    mockFetch();
    expect(await siweLoginWithInjectedWallet("https://api.test")).toBeNull();
  });

  it("throws loudly on a failed verify instead of storing a dead session", async () => {
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    await installE2eWalletIfRequested();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/auth/siwe/nonce")) {
          return new Response(JSON.stringify(NONCE_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("nope", { status: 401 });
      }),
    );

    await expect(
      siweLoginWithInjectedWallet("https://api.test"),
    ).rejects.toThrow(/verify failed: 401/);
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
  });

  it("retries a transient 503 nonce store outage, then completes the handshake", async () => {
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    await installE2eWalletIfRequested();
    let nonceCalls = 0;
    const verified: { message?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/siwe/nonce")) {
          nonceCalls += 1;
          // First two attempts hit a Redis-backed nonce-store outage.
          if (nonceCalls < 3) {
            return new Response(
              JSON.stringify({
                error: "Nonce storage unavailable",
                code: "nonce_storage_unavailable",
              }),
              { status: 503, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(JSON.stringify(NONCE_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/auth/siwe/verify")) {
          verified.message = (
            JSON.parse(String(init?.body)) as { message: string }
          ).message;
          return new Response(
            JSON.stringify({ apiKey: "eliza_test_api_key", address: "0x" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const apiKey = await siweLoginWithInjectedWallet("https://api.test");
    expect(apiKey).toBe("eliza_test_api_key");
    expect(nonceCalls).toBe(3);
    expect(verified.message).toContain(`Nonce: ${NONCE_RESPONSE.nonce}`);
    expect(window.localStorage.getItem("steward_session_token")).toBe(
      "eliza_test_api_key",
    );
  });

  it("does NOT retry a deterministic 4xx nonce rejection", async () => {
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    await installE2eWalletIfRequested();
    let nonceCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/auth/siwe/nonce")) {
          nonceCalls += 1;
          return new Response("bad request", { status: 400 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await expect(
      siweLoginWithInjectedWallet("https://api.test"),
    ).rejects.toThrow(/nonce request failed: 400/);
    expect(nonceCalls).toBe(1);
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
  });

  it("surfaces the failure after exhausting nonce retries on a sustained outage", async () => {
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    await installE2eWalletIfRequested();
    let nonceCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/auth/siwe/nonce")) {
          nonceCalls += 1;
          return new Response(
            JSON.stringify({ code: "nonce_storage_unavailable" }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await expect(
      siweLoginWithInjectedWallet("https://api.test"),
    ).rejects.toThrow(/nonce request failed: 503/);
    expect(nonceCalls).toBe(3);
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
  });
});

/**
 * #18458: SIWE chain binding. The signed authority must match the wallet's
 * actual connected chain. These tests use a controllable fake provider so each
 * chain state (Base, BSC, Ethereum mainnet, unsupported, absent, mid-prompt
 * switch) can be exercised independently of the harness wallet.
 */
describe("SIWE chain binding (#18458)", () => {
  it("permits Base (8453) and BSC (56) as supported login chains", () => {
    expect(SUPPORTED_SIWE_LOGIN_CHAIN_IDS).toEqual([8453, 56]);
    expect(isSupportedLoginChainId(8453)).toBe(true);
    expect(isSupportedLoginChainId(56)).toBe(true);
  });

  it("rejects Ethereum mainnet (1) as a supported login chain", () => {
    expect(isSupportedLoginChainId(1)).toBe(false);
  });

  function fakeProvider(chainIdHex: string | null, account = ACCOUNT.address) {
    let currentChain = chainIdHex;
    const request = vi.fn(
      async (args: { method: string; params?: readonly unknown[] }) => {
        switch (args.method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [account];
          case "eth_chainId":
            if (currentChain === null) throw new Error("chain not ready");
            return currentChain;
          case "personal_sign": {
            const [data] = args.params ?? [];
            if (typeof data !== "string") {
              throw new Error("personal_sign requires hex message data");
            }
            return ACCOUNT.signMessage({
              message: { raw: data as `0x${string}` },
            });
          }
          default:
            throw new Error(`unhandled method ${args.method}`);
        }
      },
    );
    return {
      provider: { request, isElizaE2eWallet: true },
      setChain: (hex: string | null) => {
        currentChain = hex;
      },
      request,
    };
  }

  function nonceMockForChain(chainId: number) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/siwe/nonce")) {
        return new Response(
          JSON.stringify({
            ...NONCE_RESPONSE,
            nonce: `nonce-${chainId}`,
            chainId,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/siwe/verify")) {
        return new Response(
          JSON.stringify({ apiKey: "eliza_test_api_key", address: "0x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  beforeEach(() => {
    // readWalletChainId / siweLoginWithInjectedWallet read window.ethereum.
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "ethereum");
  });

  it("reads the wallet chain from eth_chainId (Base = 0x2105)", async () => {
    const { provider } = fakeProvider("0x2105");
    expect(await readWalletChainId(provider)).toBe(8453);
  });

  it("reads the wallet chain from eth_chainId (BSC = 0x38)", async () => {
    const { provider } = fakeProvider("0x38");
    expect(await readWalletChainId(provider)).toBe(56);
  });

  it("completes login on BSC (56) and binds chain 56 to the message", async () => {
    const { provider, request } = fakeProvider("0x38");
    (window as { ethereum?: unknown }).ethereum = provider;
    const fetchMock = nonceMockForChain(56);
    vi.stubGlobal("fetch", fetchMock);

    const apiKey = await siweLoginWithInjectedWallet("https://api.test/");
    expect(apiKey).toBe("eliza_test_api_key");

    // The nonce request carried the wallet's BSC chain id.
    const nonceUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(nonceUrl).toContain("chainId=56");
    // eth_chainId was read (pre-nonce) and re-read (pre-sign) for switch detection.
    const chainCalls = request.mock.calls.filter(
      (c) => c[0]?.method === "eth_chainId",
    );
    expect(chainCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("fails closed when the wallet is on Ethereum mainnet (1)", async () => {
    const { provider } = fakeProvider("0x1");
    (window as { ethereum?: unknown }).ethereum = provider;
    vi.stubGlobal("fetch", nonceMockForChain(1));

    await expect(
      siweLoginWithInjectedWallet("https://api.test/"),
    ).rejects.toThrow(/supported chain.*but the wallet is on chain 1/);
    // No session stored on failure.
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
  });

  it("fails closed on an unsupported chain (e.g. Polygon 137)", async () => {
    const { provider } = fakeProvider("0x89"); // Polygon mainnet = 137
    (window as { ethereum?: unknown }).ethereum = provider;
    vi.stubGlobal("fetch", nonceMockForChain(137));

    await expect(
      siweLoginWithInjectedWallet("https://api.test/"),
    ).rejects.toThrow(/supported chain.*chain 137/);
  });

  it("fails closed when eth_chainId is absent/unavailable", async () => {
    const { provider } = fakeProvider(null);
    (window as { ethereum?: unknown }).ethereum = provider;
    vi.stubGlobal("fetch", nonceMockForChain(8453));

    await expect(
      siweLoginWithInjectedWallet("https://api.test/"),
    ).rejects.toThrow(/eth_chainId was unavailable/);
  });

  it("fails closed when the server-issued nonce chain disagrees with the wallet chain", async () => {
    // Wallet is on Base (8453) but the server returns chainId 1 in the nonce.
    const { provider } = fakeProvider("0x2105");
    (window as { ethereum?: unknown }).ethereum = provider;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/auth/siwe/nonce")) {
          return new Response(
            JSON.stringify({ ...NONCE_RESPONSE, chainId: 1 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await expect(
      siweLoginWithInjectedWallet("https://api.test/"),
    ).rejects.toThrow(/nonce bound chain 1.*wallet is on chain 8453/);
  });

  it("fails closed when the wallet switches to an unsupported chain mid-prompt", async () => {
    const { provider, setChain } = fakeProvider("0x2105"); // starts on Base
    (window as { ethereum?: unknown }).ethereum = provider;
    let nonceSeen = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/auth/siwe/nonce")) {
          nonceSeen = true;
          return new Response(
            JSON.stringify({ ...NONCE_RESPONSE, chainId: 8453 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    // After the nonce is fetched, flip the wallet to Polygon (unsupported)
    // before the pre-sign chain re-read runs. We can't intercept between the
    // two reads synchronously, so flip on the first eth_chainId call AFTER the
    // nonce leg. The original 'provider.request' mock is a vi.fn; wrap it.
    const origRequest = provider.request;
    provider.request = vi.fn(async (args: { method: string }) => {
      if (args.method === "eth_chainId" && nonceSeen) {
        setChain("0x89"); // switch to Polygon 137 for subsequent reads
      }
      return origRequest(args);
    }) as typeof provider.request;

    await expect(
      siweLoginWithInjectedWallet("https://api.test/"),
    ).rejects.toThrow(/switched to unsupported chain 137/);
  });

  /** Nonce mock that echoes back whatever chainId the request asked for. */
  function nonceEchoMock() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/siwe/nonce")) {
        const chainId = Number(new URL(url).searchParams.get("chainId"));
        return new Response(
          JSON.stringify({
            ...NONCE_RESPONSE,
            nonce: `nonce-${chainId}`,
            chainId,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/siwe/verify")) {
        return new Response(
          JSON.stringify({ apiKey: "eliza_test_api_key", address: "0x" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("rebuilds once and completes when the wallet settles on another supported chain mid-prompt", async () => {
    const { provider, setChain } = fakeProvider("0x2105"); // starts on Base
    (window as { ethereum?: unknown }).ethereum = provider;
    let nonceSeen = false;
    const fetchMock = nonceEchoMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/auth/siwe/nonce")) nonceSeen = true;
        return fetchMock(input);
      }),
    );

    // After the first nonce, flip the wallet to BSC (supported) permanently so
    // the pre-sign re-read detects the switch exactly once.
    const origRequest = provider.request;
    let flipped = false;
    provider.request = vi.fn(async (args: { method: string }) => {
      if (args.method === "eth_chainId" && nonceSeen && !flipped) {
        flipped = true;
        setChain("0x38"); // BSC 56
      }
      return origRequest(args);
    }) as typeof provider.request;

    const apiKey = await siweLoginWithInjectedWallet("https://api.test/");
    expect(apiKey).toBe("eliza_test_api_key");

    // Two nonce fetches: the abandoned Base attempt and the completed BSC one.
    const nonceUrls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/auth/siwe/nonce"));
    expect(nonceUrls).toHaveLength(2);
    expect(nonceUrls[0]).toContain("chainId=8453");
    expect(nonceUrls[1]).toContain("chainId=56");
  });

  it("fails closed instead of recursing when the wallet keeps flipping between supported chains", async () => {
    const { provider, setChain } = fakeProvider("0x2105"); // starts on Base
    (window as { ethereum?: unknown }).ethereum = provider;
    let nonceSeen = false;
    const fetchMock = nonceEchoMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/auth/siwe/nonce")) nonceSeen = true;
        return fetchMock(input);
      }),
    );

    // A pathological wallet that toggles Base <-> BSC on every chain read
    // after the first nonce: every pre-sign re-read sees a different
    // supported chain, so an unbounded rebuild would never terminate.
    let toggle = false;
    const origRequest = provider.request;
    provider.request = vi.fn(async (args: { method: string }) => {
      if (args.method === "eth_chainId" && nonceSeen) {
        toggle = !toggle;
        setChain(toggle ? "0x38" : "0x2105");
      }
      return origRequest(args);
    }) as typeof provider.request;

    await expect(
      siweLoginWithInjectedWallet("https://api.test/"),
    ).rejects.toThrow(/kept switching chains/);
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
  });

  it("fails closed on a hung SIWE verify hop instead of waiting forever", async () => {
    window.localStorage.setItem(E2E_WALLET_KEY_STORAGE_KEY, PRIVATE_KEY);
    await installE2eWalletIfRequested();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(
          Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          }),
        );
      }, 50);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/siwe/nonce")) {
          return new Response(JSON.stringify(NONCE_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const abort = () => reject(signal.reason);
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        });
      }),
    );
    const started = Date.now();
    await expect(
      siweLoginWithInjectedWallet("https://api.test/"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
  });
});
