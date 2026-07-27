/**
 * Exercises provider-owned source placement attestation resolution and exact
 * comparison so snapshot claims cannot substitute another runtime's identity.
 */
import { describe, expect, test } from "vitest";
import type { AgentSnapshotUpgradeBinding } from "./agent-backup.ts";
import {
  resolveAgentSnapshotSourceAttestation,
  verifyAgentSnapshotSourceAttestation,
} from "./agent-snapshot-source-attestation.ts";

const BINDING: AgentSnapshotUpgradeBinding = {
  backupId: "11111111-1111-4111-8111-111111111111",
  captureNonce: "01".repeat(32),
  sourceEnvironmentRevision: 7,
  sourceImageDigest: `sha256:${"02".repeat(32)}`,
  sourceSandboxId: "33333333-3333-4333-8333-333333333333",
  targetImageDigest: `sha256:${"03".repeat(32)}`,
  targetReplacementAttemptId: "22222222-2222-4222-8222-222222222222",
  targetSandboxId: "target-sandbox",
};

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ELIZA_SNAPSHOT_SOURCE_ENVIRONMENT_REVISION: "7",
    ELIZA_SNAPSHOT_SOURCE_IMAGE_DIGEST: BINDING.sourceImageDigest,
    ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID: BINDING.sourceSandboxId,
    ...overrides,
  };
}

describe("agent snapshot source attestation", () => {
  test("requires one complete canonical provider identity", () => {
    expect(resolveAgentSnapshotSourceAttestation({})).toBeNull();
    expect(() =>
      resolveAgentSnapshotSourceAttestation({
        ELIZA_SNAPSHOT_SOURCE_ENVIRONMENT_REVISION: "7",
      }),
    ).toThrow("partially configured");
    expect(() =>
      resolveAgentSnapshotSourceAttestation(
        environment({
          ELIZA_SNAPSHOT_SOURCE_IMAGE_DIGEST: "02".repeat(32),
        }),
      ),
    ).toThrow("malformed");
    expect(() =>
      resolveAgentSnapshotSourceAttestation(
        environment({
          ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID: "agent-friendly-name",
        }),
      ),
    ).toThrow("malformed");
    expect(resolveAgentSnapshotSourceAttestation(environment())).toEqual({
      sourceEnvironmentRevision: 7,
      sourceImageDigest: BINDING.sourceImageDigest,
      sourceSandboxId: BINDING.sourceSandboxId,
    });
  });

  test("rejects missing and confused-deputy source claims", () => {
    expect(() => verifyAgentSnapshotSourceAttestation(BINDING, null)).toThrow(
      "no provider-owned snapshot source attestation",
    );
    for (const binding of [
      { ...BINDING, sourceEnvironmentRevision: 8 },
      { ...BINDING, sourceImageDigest: `sha256:${"04".repeat(32)}` },
      {
        ...BINDING,
        sourceSandboxId: "55555555-5555-4555-8555-555555555555",
      },
    ]) {
      expect(() =>
        verifyAgentSnapshotSourceAttestation(
          binding,
          resolveAgentSnapshotSourceAttestation(environment()),
        ),
      ).toThrow("does not match this source placement");
    }
    expect(() =>
      verifyAgentSnapshotSourceAttestation(
        BINDING,
        resolveAgentSnapshotSourceAttestation(environment()),
      ),
    ).not.toThrow();
  });
});
