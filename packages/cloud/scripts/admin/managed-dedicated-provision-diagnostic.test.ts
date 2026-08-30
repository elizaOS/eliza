/**
 * Managed Dedicated provision diagnostics prove that exact raw staging rows
 * become useful closed categories without leaking operator text or identities.
 */

import { describe, expect, test } from "bun:test";
import {
  canonicalizeManagedDedicatedProvisionDiagnostic,
  classifyManagedDedicatedProvisionFailure,
  sanitizeManagedDedicatedProvisionDiagnostic,
} from "./managed-dedicated-provision-diagnostic";

const SUFFIX = "r33281731880a1";

function rawDiagnostic(
  error: string | null = "No available Docker nodes with capacity",
) {
  return {
    targetCount: 1,
    agent: {
      status: "error",
      executionTier: "dedicated-always",
      databaseStatus: "none",
      errorMessage: error,
      errorCount: 1,
      updatedAt: "2026-08-29T23:47:00.000Z",
      locator: {
        sandboxIdPresent: false,
        nodeIdPresent: false,
        containerNamePresent: false,
        headscaleIpPresent: false,
      },
      replacementLocator: {
        sandboxIdPresent: true,
        nodeIdPresent: true,
        containerNamePresent: true,
        attemptIdPresent: true,
        containerIdPresent: false,
        vpnNodeIdPresent: false,
      },
    },
    provisionJob: {
      status: "failed",
      error,
      resultError: error,
      attempts: 3,
      maxAttempts: 3,
      retryableRequeues: 0,
      executionInterruptions: 0,
      resultStorage: "inline",
      errorStorage: "inline",
      scheduledFor: "2026-08-29T23:43:00.000Z",
      startedAt: "2026-08-29T23:43:01.000Z",
      completedAt: null,
      createdAt: "2026-08-29T23:43:00.000Z",
      updatedAt: "2026-08-29T23:47:00.000Z",
    },
  };
}

describe("managed Dedicated provision diagnostic", () => {
  test("classifies the main private provisioning failure families", () => {
    expect(
      classifyManagedDedicatedProvisionFailure(
        "pull access denied for image",
        "x",
      ),
    ).toBe("image");
    expect(
      classifyManagedDedicatedProvisionFailure("KMS decrypt failed", "x"),
    ).toBe("secrets");
    expect(
      classifyManagedDedicatedProvisionFailure("failed query: select 1", "x"),
    ).toBe("database");
    expect(
      classifyManagedDedicatedProvisionFailure("Headscale route missing", "x"),
    ).toBe("ingress");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "No available Docker nodes",
        "x",
      ),
    ).toBe("capacity");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] Registered Docker nodes exist but none are available for placement",
        "x",
      ),
    ).toBe("capacity");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] No nodes available (excludeNodeId=none filtered out all seed nodes)",
        "x",
      ),
    ).toBe("capacity");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Unexpected control-plane failure\n    at DockerSandboxProvider.create (/opt/eliza/docker-sandbox-provider.ts:42:7)",
        "x",
      ),
    ).toBe("unclassified");
  });

  test("emits only closed facts and never the raw operator error", () => {
    const raw = rawDiagnostic(
      "pull access denied for ghcr.example/private/image with secret token value",
    );
    const diagnostic = sanitizeManagedDedicatedProvisionDiagnostic(raw, SUFFIX);
    expect(diagnostic.provisionJob.errorCode).toBe("secrets");
    expect(diagnostic.sandbox.locator.nodeIdPresent).toBe(false);
    expect(diagnostic.sandbox.replacementLocator.nodeIdPresent).toBe(true);

    const canonical =
      canonicalizeManagedDedicatedProvisionDiagnostic(diagnostic);
    expect(canonical).not.toContain("ghcr.example");
    expect(canonical).not.toContain("token value");
    expect(canonical).not.toContain(SUFFIX);
  });

  test("distinguishes safe container-control subcategories", () => {
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] Failed to create container on node: [docker-ssh] Permission denied (publickey)",
        "x",
      ),
    ).toBe("container_ssh_auth");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] Failed to create container: [docker-ssh] Connection timed out after 10000ms",
        "x",
      ),
    ).toBe("container_ssh_timeout");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] Failed to create container: [docker-ssh] ECONNREFUSED",
        "x",
      ),
    ).toBe("container_ssh_refused");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] Failed to create container: [docker-ssh] Connection error for node: All configured authentication methods failed",
        "x",
      ),
    ).toBe("container_ssh_auth");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] Failed to create container: [docker-ssh] Command exited with code 1 on node",
        "x",
      ),
    ).toBe("container_ssh_command_exit");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-sandbox] Failed to create container on node: Cannot connect to the Docker daemon",
        "x",
      ),
    ).toBe("container_daemon");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Docker replacement identity changed across durable stages",
        "x",
      ),
    ).toBe("container_identity");
  });

  test("fails closed on the wrong tier, ambiguous target, or extra raw fields", () => {
    const wrongTier = rawDiagnostic();
    wrongTier.agent.executionTier = "shared";
    expect(() =>
      sanitizeManagedDedicatedProvisionDiagnostic(wrongTier, SUFFIX),
    ).toThrow("dedicated-always");

    const ambiguous = rawDiagnostic();
    ambiguous.targetCount = 2;
    expect(() =>
      sanitizeManagedDedicatedProvisionDiagnostic(ambiguous, SUFFIX),
    ).toThrow("exactly one target");

    const extra = rawDiagnostic() as ReturnType<typeof rawDiagnostic> & {
      rawError?: string;
    };
    extra.rawError = "must not pass";
    expect(() =>
      sanitizeManagedDedicatedProvisionDiagnostic(extra, SUFFIX),
    ).toThrow("unexpected shape");
  });
});
