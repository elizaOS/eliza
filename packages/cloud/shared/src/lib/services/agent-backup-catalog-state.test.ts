import { describe, expect, it } from "vitest";
import {
  assertAgentBackupCatalogTransition,
  boundedBackupCatalogError,
  catalogStateAllowsRestore,
  catalogStateRequiresManifest,
  requireBoundedIdentity,
  requireSha256Hex,
} from "./agent-backup-catalog-state";

describe("agent backup catalogue state", () => {
  it("accepts the complete protected lifecycle and rejects skipped proof", () => {
    const path = [
      "scheduled",
      "capturing",
      "captured",
      "uploading",
      "primary_uploaded",
      "primary_verified",
      "secondary_pending",
      "protected",
      "retained",
      "expiration_pending",
      "deleting",
      "deleted",
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      assertAgentBackupCatalogTransition({ from: path[i], to: path[i + 1] });
    }
    expect(() =>
      assertAgentBackupCatalogTransition({ from: "primary_verified", to: "protected" }),
    ).toThrow("Invalid backup catalogue transition");
    expect(() => assertAgentBackupCatalogTransition({ from: "captured", to: "retained" })).toThrow(
      "Invalid backup catalogue transition",
    );
  });

  it("resumes a retry only at the state that failed", () => {
    assertAgentBackupCatalogTransition({
      from: "uploading",
      to: "failed_retryable",
      resumeState: "uploading",
    });
    assertAgentBackupCatalogTransition({
      from: "failed_retryable",
      to: "uploading",
      resumeState: "uploading",
    });
    expect(() =>
      assertAgentBackupCatalogTransition({
        from: "failed_retryable",
        to: "primary_verified",
        resumeState: "uploading",
      }),
    ).toThrow("only resume its recorded state");
    expect(() =>
      assertAgentBackupCatalogTransition({
        from: "capturing",
        to: "failed_retryable",
        resumeState: "uploading",
      }),
    ).toThrow("preserve the exact state");
    assertAgentBackupCatalogTransition({
      from: "capturing",
      to: "failed_terminal",
      resumeState: "capturing",
    });
  });

  it("classifies manifest and restore gates without treating upload as protection", () => {
    expect(catalogStateRequiresManifest("scheduled")).toBe(false);
    expect(catalogStateRequiresManifest("captured")).toBe(true);
    expect(catalogStateAllowsRestore("primary_uploaded")).toBe(false);
    expect(catalogStateAllowsRestore("primary_verified")).toBe(true);
    expect(catalogStateAllowsRestore("failed_retryable")).toBe(false);
  });

  it("validates digests, bounded identities and privacy-safe errors", () => {
    expect(requireSha256Hex("a".repeat(64), "digest")).toBe("a".repeat(64));
    expect(() => requireSha256Hex("A".repeat(64), "digest")).toThrow("lowercase");
    expect(requireBoundedIdentity("node-robot-01", "nodeId")).toBe("node-robot-01");
    expect(() => requireBoundedIdentity(" node", "nodeId")).toThrow("canonical");
    expect(
      boundedBackupCatalogError({
        code: "R2_TIMEOUT",
        message: " timeout\nwhile uploading ".repeat(300),
      }),
    ).toEqual({ code: "R2_TIMEOUT", message: expect.stringMatching(/^timeout while uploading/) });
    expect(
      boundedBackupCatalogError({ code: "R2_TIMEOUT", message: "x".repeat(10_000) }).message,
    ).toHaveLength(2_048);
    expect(() => boundedBackupCatalogError({ code: "bad-code", message: "x" })).toThrow(
      "error code",
    );
  });
});
