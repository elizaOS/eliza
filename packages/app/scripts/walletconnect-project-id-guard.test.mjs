/**
 * Unit tests for the WalletConnect project-ID build-time guard logic.
 *
 * Proves the guard accepts valid injection and rejects missing, blank, and
 * placeholder values — the core acceptance criterion of issue #18459. The
 * guard mirrors the runtime validation in
 * packages/ui/src/cloud/billing/wallet/walletconnect-project-id.ts.
 */
import { describe, expect, it } from "vitest";

import {
  WALLETCONNECT_PLACEHOLDER,
  resolveWalletConnectProjectId,
  walletConnectProjectIdRejectionReason,
} from "./walletconnect-project-id-guard.mjs";

describe("resolveWalletConnectProjectId (guard)", () => {
  it("returns a trimmed valid project ID", () => {
    expect(resolveWalletConnectProjectId("  abc123def456  ")).toBe(
      "abc123def456",
    );
  });

  it("passes a realistic WalletConnect project ID", () => {
    const realistic = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    expect(resolveWalletConnectProjectId(realistic)).toBe(realistic);
  });

  it("returns undefined for undefined input", () => {
    expect(resolveWalletConnectProjectId(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(resolveWalletConnectProjectId("")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only string", () => {
    expect(resolveWalletConnectProjectId("   \t\n  ")).toBeUndefined();
  });

  it("returns undefined for the exact placeholder", () => {
    expect(resolveWalletConnectProjectId(WALLETCONNECT_PLACEHOLDER)).toBeUndefined();
  });

  it("returns undefined for placeholder substrings", () => {
    for (const bad of [
      "your_wc_project_id",
      "YOUR_WC_PROJECT_ID",
      "your-wc-project-id",
      "replace_with_value",
      "placeholder_value",
      "changeme",
      "xxx",
      "TODO_set_this",
    ]) {
      expect(resolveWalletConnectProjectId(bad), `input: ${bad}`).toBeUndefined();
    }
  });
});

describe("walletConnectProjectIdRejectionReason (guard)", () => {
  it("returns undefined for a valid project ID", () => {
    expect(
      walletConnectProjectIdRejectionReason("real_project_123"),
    ).toBeUndefined();
  });

  it("returns a missing-reason for blank input", () => {
    expect(walletConnectProjectIdRejectionReason("")).toContain("missing");
  });

  it("returns a missing-reason for undefined input", () => {
    expect(walletConnectProjectIdRejectionReason(undefined)).toContain(
      "missing",
    );
  });

  it("returns a placeholder-reason for the placeholder", () => {
    const reason = walletConnectProjectIdRejectionReason(
      WALLETCONNECT_PLACEHOLDER,
    );
    expect(reason).toContain("placeholder");
    expect(reason).toContain("YOUR_WC_PROJECT_ID");
  });
});
