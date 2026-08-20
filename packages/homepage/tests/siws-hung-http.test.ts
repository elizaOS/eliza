/**
 * Unit coverage for homepage SIWS nonce/verify: honest success and hung-probe
 * fail-closed. Deterministic fetch mocks; no live Cloud or wallet.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { signInWithSolana } from "../src/lib/api/siws";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalAbortSignalTimeout = AbortSignal.timeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
  // Bun mock.restore() does not reverse a direct property assignment.
  AbortSignal.timeout = originalAbortSignalTimeout;
  mock.restore();
});

function installTestSigner(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      __siwsTestSigner: {
        publicKey: "11111111111111111111111111111111",
        sign: () => new Uint8Array([1, 2, 3, 4]),
      },
    },
  });
}

function hungFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const abort = () => {
      reject(
        signal.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

describe("homepage SIWS hung HTTP", () => {
  test("returns verified credentials from nonce plus verify", async () => {
    installTestSigner();
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/siws/nonce")) {
        return Response.json({
          nonce: "n1",
          domain: "eliza.app",
          uri: "https://eliza.app",
          chainId: "solana:mainnet",
          version: "1",
          statement: "Sign in",
        });
      }
      if (url.includes("/api/auth/siws/verify")) {
        return Response.json({
          apiKey: "key",
          address: "11111111111111111111111111111111",
          isNewAccount: false,
          user: {
            id: "u1",
            wallet_address: "11111111111111111111111111111111",
            organization_id: "o1",
          },
          organization: { id: "o1", name: "Org", slug: "org" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await signInWithSolana();
    expect(result.apiKey).toBe("key");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const nonceInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(nonceInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("fails closed on a hung nonce hop instead of waiting forever", async () => {
    installTestSigner();
    const timeoutSpy = mock(() => {
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
    AbortSignal.timeout = timeoutSpy as typeof AbortSignal.timeout;
    globalThis.fetch = hungFetch as typeof fetch;
    const started = Date.now();
    await expect(signInWithSolana()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    AbortSignal.timeout = originalAbortSignalTimeout;
    expect(AbortSignal.timeout).toBe(originalAbortSignalTimeout);
  });

  test("does not leak the 50ms AbortSignal.timeout spy into later tests", () => {
    expect(AbortSignal.timeout).toBe(originalAbortSignalTimeout);
  });
});
