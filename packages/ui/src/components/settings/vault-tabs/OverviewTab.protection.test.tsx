// @vitest-environment jsdom

/** Verifies the Vault overview's device-protection trust-domain disclosure. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProtectionCard } from "./OverviewTab";
import type { VaultProtectionStatus } from "./types";

const protection: VaultProtectionStatus = {
  localVault: {
    encryptedAtRest: true,
    cipher: "AES-256-GCM",
    masterKey: {
      backend: "macos_keychain",
      available: true,
      synchronized: false,
      scope: "host",
      access: "app_only",
    },
  },
  nativeSessionState: {
    policy: "platform-protected-store",
    synchronized: false,
    plaintextFallback: false,
  },
  connectorSessions: {
    telegramPersonal: "vault-master-key-encrypted",
  },
  cloudTrustDomain: "separate-organization-kms",
};

describe("Vault protection card", () => {
  it("shows device protection, fail-closed native sessions, and Cloud separation", () => {
    render(<ProtectionCard protection={protection} />);

    expect(screen.getByText("Protected by this device")).toBeTruthy();
    expect(
      screen.getByText(/require the platform protected store/),
    ).toBeTruthy();
    expect(screen.getByText(/plaintext fallback are off/)).toBeTruthy();
    expect(screen.getByText(/separate KMS trust domain/)).toBeTruthy();
    expect(
      screen.getByText(/Telegram Personal session state is encrypted/),
    ).toBeTruthy();
  });
});
