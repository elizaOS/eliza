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
        "Replacement cleanup is unresolved: Headscale routing is required, but the sandbox did not register a headscale_ip.\ncaused by: AggregateError: Headscale routing is required, but the sandbox did not register a headscale_ip.\ncaused by: ElizaError: Docker candidate cannot complete required Headscale registration: auth_required\n    at /private/docker-sandbox-provider.ts:42:7",
        "x",
      ),
    ).toBe("ingress_mesh_auth_required");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Replacement cleanup is unresolved: Headscale routing is required, but the sandbox did not register a headscale_ip.\ncaused by: Error: Headscale registration did not reach an exact observable completion",
        "x",
      ),
    ).toBe("ingress_headscale_registration_unresolved");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Headscale routing is required, but the sandbox did not register a headscale_ip.",
        "x",
      ),
    ).toBe("ingress_headscale_ip_missing");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Headscale routing is required, but HEADSCALE_API_KEY is not configured.",
        "x",
      ),
    ).toBe("ingress_headscale_not_configured");
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

  test("classifies legacy oversized retry diagnostics without emitting their text", () => {
    const repeatedPriorError = `${"RetryableProvisionTransportError: cleanup pending\n".repeat(
      220,
    )}caused by: Error: Docker candidate cannot complete required Headscale registration: auth_required`;
    expect(repeatedPriorError.length).toBeGreaterThan(8_000);
    expect(
      classifyManagedDedicatedProvisionFailure(repeatedPriorError, "x"),
    ).toBe("ingress_mesh_auth_required");

    const unknownOversized = "unknown legacy retry failure\n".repeat(400);
    expect(
      classifyManagedDedicatedProvisionFailure(unknownOversized, "x"),
    ).toBe("diagnostic_oversize");
    expect(() =>
      classifyManagedDedicatedProvisionFailure("x".repeat(1_048_577), "x"),
    ).toThrow("bounded string");
  });

  test("accepts a terminal non-retryable failure before max attempts", () => {
    const raw = rawDiagnostic("invalid non-retryable provisioning input");
    raw.provisionJob.attempts = 1;

    const diagnostic = sanitizeManagedDedicatedProvisionDiagnostic(raw, SUFFIX);
    expect(diagnostic.provisionJob.status).toBe("failed");
    expect(diagnostic.provisionJob.attempts).toBe(1);
    expect(diagnostic.provisionJob.maxAttempts).toBe(3);
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
        "[docker-ssh] Command exited with code 1 on node-a: ",
        "x",
      ),
    ).toBe("container_ssh_command_exit_empty");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 70 on node-a: [stderr] [docker-network] daemon-unavailable",
        "x",
      ),
    ).toBe("container_network_daemon_unavailable");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 71 on node-a: [stderr] [docker-network] ensure-failed",
        "x",
      ),
    ).toBe("container_network_ensure_failed");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 1 on node-a: [stderr] mkdir: No space left on device",
        "x",
      ),
    ).toBe("container_volume_disk_full");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 69 on node-a: [stderr] [docker-sandbox] Steward request failed",
        "x",
      ),
    ).toBe("container_steward_request_failed");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 1 on node-a: [stderr] Steward agent registration failed with status 401",
        "x",
      ),
    ).toBe("container_steward_agent_registration_unauthorized");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 1 on node-a: [stderr] Steward agent registration failed with status 422",
        "x",
      ),
    ).toBe("container_steward_agent_registration_client_error");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 1 on node-a: [stderr] Steward agent registration failed with status 503",
        "x",
      ),
    ).toBe("container_steward_agent_registration_server_error");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "[docker-ssh] Command exited with code 1 on node-a: [stderr] python3: command not found",
        "x",
      ),
    ).toBe("container_remote_python_missing");
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
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Replacement cleanup is still pending: Sandbox provider cannot prove a persisted replacement absent",
        "x",
      ),
    ).toBe("container_replacement_cleanup_absence_unproven");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Replacement cleanup is still pending: Replacement cleanup locator is incomplete",
        "x",
      ),
    ).toBe("container_replacement_cleanup_locator_invalid");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Replacement cleanup is still pending: Replacement cleanup fence changed after remote absence proof",
        "x",
      ),
    ).toBe("container_replacement_cleanup_authority_changed");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Replacement cleanup is still pending: Replacement cleanup node node-a disappeared before release",
        "x",
      ),
    ).toBe("container_replacement_cleanup_capacity");
    expect(
      classifyManagedDedicatedProvisionFailure(
        "Replacement cleanup is still pending: unexpected fixed-shape cleanup failure",
        "x",
      ),
    ).toBe("container_replacement_cleanup_pending");
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
