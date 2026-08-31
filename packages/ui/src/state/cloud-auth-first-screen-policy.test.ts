/**
 * Verifies that Cloud account login owns only Cloud-controlled browser origins
 * or cloud-only native/desktop clients, never a standalone agent pairing page.
 */

import { describe, expect, it } from "vitest";
import { cloudAuthFirstScreenOwnsHost } from "./cloud-auth-first-screen-policy";

describe("cloudAuthFirstScreenOwnsHost", () => {
  it("keeps a self-hosted browser on the standalone agent pairing surface", () => {
    expect(
      cloudAuthFirstScreenOwnsHost({
        cloudOnlyBranding: true,
        isAgentlessCloudOrigin: false,
        isNative: false,
        isDesktopShell: false,
      }),
    ).toBe(false);
  });

  it("lets the Cloud control plane own hosted browser sign-in", () => {
    expect(
      cloudAuthFirstScreenOwnsHost({
        cloudOnlyBranding: true,
        isAgentlessCloudOrigin: true,
        isNative: false,
        isDesktopShell: false,
      }),
    ).toBe(true);
  });

  it.each([
    { isNative: true, isDesktopShell: false },
    { isNative: false, isDesktopShell: true },
  ])(
    "retains cloud-only client login for $isNative/$isDesktopShell",
    (host) => {
      expect(
        cloudAuthFirstScreenOwnsHost({
          cloudOnlyBranding: true,
          isAgentlessCloudOrigin: false,
          ...host,
        }),
      ).toBe(true);
    },
  );

  it("does not claim any host when cloud-only branding is disabled", () => {
    expect(
      cloudAuthFirstScreenOwnsHost({
        cloudOnlyBranding: false,
        isAgentlessCloudOrigin: true,
        isNative: true,
        isDesktopShell: true,
      }),
    ).toBe(false);
  });
});
