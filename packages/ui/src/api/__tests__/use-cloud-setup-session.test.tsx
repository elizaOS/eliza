// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { MockCloudSetupSessionService } from "@elizaos/cloud-sdk/cloud-setup-session";
import type { ContainerHandoffEnvelope } from "@elizaos/cloud-sdk/cloud-setup-session";
import { describe, expect, it, vi } from "vitest";
import { useCloudSetupSession } from "../cloud-setup.js";

describe("useCloudSetupSession", () => {
  it("auto-starts a session, accepts a message, and emits a handoff envelope", async () => {
    const service = new MockCloudSetupSessionService({ provisioningTurns: 1 });
    const onHandoff = vi.fn<(envelope: ContainerHandoffEnvelope) => void>();

    const { result } = renderHook(() =>
      useCloudSetupSession({
        tenantId: "tenant_test",
        service,
        pollIntervalMs: 10,
        onHandoff,
      }),
    );

    await waitFor(() => expect(result.current.envelope).not.toBeNull());
    expect(result.current.envelope?.tenantId).toBe("tenant_test");
    expect(["provisioning", "ready", "handoff"]).toContain(
      result.current.status,
    );

    await act(async () => {
      await result.current.sendMessage("Shaw");
    });
    expect(result.current.transcript.length).toBeGreaterThanOrEqual(2);
    expect(result.current.facts.some((f) => f.key === "owner.name")).toBe(true);

    await waitFor(() => expect(onHandoff).toHaveBeenCalled());
    const envelope = onHandoff.mock.calls[0]?.[0];
    expect(envelope?.containerId).toBe(result.current.envelope?.containerId);
    expect(envelope?.transcript.length).toBeGreaterThan(0);
    expect(result.current.status).toBe("handoff");
  });

  it("falls back to the in-memory mock when no service is provided", async () => {
    const { result } = renderHook(() =>
      useCloudSetupSession({ tenantId: "tenant_default", pollIntervalMs: 10 }),
    );
    await waitFor(() => expect(result.current.envelope).not.toBeNull());
    expect(result.current.envelope?.tenantId).toBe("tenant_default");
  });

  it("surfaces errors from the service on the error field", async () => {
    const service = new MockCloudSetupSessionService();
    service.startSession = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useCloudSetupSession({ service, pollIntervalMs: 10 }),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.status).toBe("error");
  });

  it("clears state on cancel", async () => {
    const service = new MockCloudSetupSessionService({ provisioningTurns: 99 });
    const { result } = renderHook(() =>
      useCloudSetupSession({ service, pollIntervalMs: 10 }),
    );
    await waitFor(() => expect(result.current.envelope).not.toBeNull());
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.envelope).toBeNull();
    expect(result.current.status).toBe("idle");
  });
});
