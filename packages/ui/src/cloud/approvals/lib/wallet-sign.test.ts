/**
 * Unit tests for wallet sign: validates provider detection and error class.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInjectedWalletAvailable, WalletSignError } from "./wallet-sign.ts";

describe("wallet-sign", () => {
  const globalScope = globalThis as unknown as { window?: unknown };

  beforeEach(() => {
    globalScope.window = {};
  });

  afterEach(() => {
    delete globalScope.window;
  });

  it("returns false when no ethereum provider is injected", () => {
    expect(isInjectedWalletAvailable()).toBe(false);
  });

  it("returns true when ethereum provider with request function is present", () => {
    globalScope.window = {
      ethereum: {
        request: async () => [],
      },
    };
    expect(isInjectedWalletAvailable()).toBe(true);
  });

  it("creates WalletSignError with correct name and message", () => {
    const err = new WalletSignError("Signature rejected");
    expect(err.name).toBe("WalletSignError");
    expect(err.message).toBe("Signature rejected");
  });
});
