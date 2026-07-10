// @vitest-environment jsdom

/**
 * Deterministic coverage for the Steward web-passkey capability gate. The
 * real browser APIs are supplied as plain objects so the tests lock the branch
 * decisions without relying on jsdom's partial WebAuthn support.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveWebPasskeyCapability } from "./passkey-capability";

const credentials = {
  get: vi.fn(),
  create: vi.fn(),
};

function publicKeyCredential(probe: () => Promise<boolean>) {
  return {
    isUserVerifyingPlatformAuthenticatorAvailable: probe,
  };
}

describe("resolveWebPasskeyCapability", () => {
  it("fails closed in Capacitor native without a native WebAuthn bridge", async () => {
    await expect(
      resolveWebPasskeyCapability({
        isSecureContext: true,
        navigator: { credentials },
        publicKeyCredential: publicKeyCredential(async () => true),
        capacitor: { isNativePlatform: () => true },
      }),
    ).resolves.toEqual({
      usable: false,
      reason: "native-without-bridge",
    });
  });

  it("requires a secure context", async () => {
    await expect(
      resolveWebPasskeyCapability({
        isSecureContext: false,
        navigator: { credentials },
        publicKeyCredential: publicKeyCredential(async () => true),
      }),
    ).resolves.toEqual({ usable: false, reason: "insecure-context" });
  });

  it("requires navigator.credentials get/create", async () => {
    await expect(
      resolveWebPasskeyCapability({
        isSecureContext: true,
        navigator: { credentials: { get: vi.fn() } },
        publicKeyCredential: publicKeyCredential(async () => true),
      }),
    ).resolves.toEqual({
      usable: false,
      reason: "missing-credentials-api",
    });
  });

  it("requires PublicKeyCredential", async () => {
    await expect(
      resolveWebPasskeyCapability({
        isSecureContext: true,
        navigator: { credentials },
      }),
    ).resolves.toEqual({
      usable: false,
      reason: "missing-public-key-credential",
    });
  });

  it("is usable only when UVPAA resolves true", async () => {
    await expect(
      resolveWebPasskeyCapability({
        isSecureContext: true,
        navigator: { credentials },
        publicKeyCredential: publicKeyCredential(async () => true),
      }),
    ).resolves.toEqual({ usable: true, reason: "available" });
  });

  it("fails closed when UVPAA resolves false", async () => {
    await expect(
      resolveWebPasskeyCapability({
        isSecureContext: true,
        navigator: { credentials },
        publicKeyCredential: publicKeyCredential(async () => false),
      }),
    ).resolves.toEqual({
      usable: false,
      reason: "platform-authenticator-unavailable",
    });
  });

  it("fails closed when UVPAA rejects", async () => {
    await expect(
      resolveWebPasskeyCapability({
        isSecureContext: true,
        navigator: { credentials },
        publicKeyCredential: publicKeyCredential(async () => {
          throw new Error("probe failed");
        }),
      }),
    ).resolves.toEqual({
      usable: false,
      reason: "platform-authenticator-probe-failed",
    });
  });
});
