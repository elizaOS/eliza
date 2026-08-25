/**
 * Executes the built wallet shim in an isolated JavaScript realm and verifies
 * EIP-6963 provider discovery uses a CSPRNG-backed RFC 4122 v4 identifier.
 */
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildWalletShim } from "./build-shim";

interface AnnouncedProviderEvent {
  detail: { info: { uuid: string } };
  type: string;
}

function executeShim(cryptoObject: object): AnnouncedProviderEvent[] {
  const events: AnnouncedProviderEvent[] = [];
  class CustomEvent {
    readonly detail: AnnouncedProviderEvent["detail"];
    readonly type: string;

    constructor(
      type: string,
      init: { detail: AnnouncedProviderEvent["detail"] },
    ) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const window = {
    addEventListener: vi.fn(),
    crypto: cryptoObject,
    dispatchEvent: vi.fn((event: AnnouncedProviderEvent) => {
      events.push(event);
      return true;
    }),
  };
  const script = buildWalletShim({
    apiBase: "http://127.0.0.1:31337",
    signToken: "test-sign-token-1234567890",
    solanaPublicKey: null,
    evmAddress: "0x1111111111111111111111111111111111111111",
  });

  vm.runInNewContext(script, {
    CustomEvent,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    console,
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    window,
  });
  return events;
}

describe("wallet browser shim EIP-6963 identity", () => {
  it("constructs a secure UUIDv4 with getRandomValues when randomUUID is absent", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });

    const events = executeShim({ getRandomValues });
    const announcement = events.find(
      (event) => event.type === "eip6963:announceProvider",
    );

    expect(announcement?.detail.info.uuid).toBe(
      "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
    expect(announcement?.detail.info.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(
      buildWalletShim({
        apiBase: "http://127.0.0.1:31337",
        signToken: "test-sign-token-1234567890",
        solanaPublicKey: null,
        evmAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).not.toContain("Math.random");
  });

  it("fails closed when the page has no cryptographically secure random source", () => {
    expect(() => executeShim({})).toThrow(
      "cryptographically secure random source",
    );
  });
});
