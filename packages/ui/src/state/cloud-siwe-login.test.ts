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
  siweLoginWithInjectedWallet,
} from "./cloud-siwe-login";

const PRIVATE_KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);

const NONCE_RESPONSE = {
  nonce: "abcDEF123456",
  domain: "elizacloud.ai",
  uri: "https://elizacloud.ai",
  version: "1",
  statement: "Sign in to Eliza Cloud",
  chainId: 1,
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
      if (url.endsWith("/api/auth/siwe/nonce")) {
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
      chainId: 1,
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
        "Chain ID: 1",
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
    const { verified } = mockFetch();

    const apiKey = await siweLoginWithInjectedWallet("https://api.test/");
    expect(apiKey).toBe("eliza_test_api_key");
    expect(window.localStorage.getItem("steward_session_token")).toBe(
      "eliza_test_api_key",
    );

    // The signed message embeds the server's nonce/domain and the signature
    // genuinely recovers to the wallet address — exactly what the cloud API's
    // verify endpoint checks.
    expect(verified.message).toContain(`Nonce: ${NONCE_RESPONSE.nonce}`);
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
        if (url.endsWith("/api/auth/siwe/nonce")) {
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
});
