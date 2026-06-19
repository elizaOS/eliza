import { describe, expect, it } from "vitest";
import { MockCloudSetupSessionService } from "../mock-service.js";

function makeService(): MockCloudSetupSessionService {
  let counter = 0;
  return new MockCloudSetupSessionService({
    now: () => 1_000_000 + counter,
    randomId: () => `id_${++counter}`,
    provisioningTurns: 1,
  });
}

describe("MockCloudSetupSessionService", () => {
  it("starts a session in the provisioning state with an opening message", async () => {
    const service = makeService();
    const envelope = await service.startSession({ tenantId: "tenant_a" });
    expect(envelope.tenantId).toBe("tenant_a");
    expect(envelope.containerStatus).toBe("provisioning");
    expect(envelope.sessionId).toBeTruthy();
    expect(envelope.containerId).toBeTruthy();
  });

  it("returns canned replies and extracts owner facts on early turns", async () => {
    const service = makeService();
    const envelope = await service.startSession({ tenantId: "tenant_a" });
    const first = await service.sendMessage({
      sessionId: envelope.sessionId,
      message: "Shaw",
    });
    expect(first.replies).toHaveLength(1);
    expect(first.facts).toHaveLength(1);
    expect(first.facts[0]?.key).toBe("owner.name");
    expect(first.facts[0]?.value).toBe("Shaw");

    const second = await service.sendMessage({
      sessionId: envelope.sessionId,
      message: "English",
    });
    expect(second.facts[0]?.key).toBe("owner.language");
  });

  it("flips container status to ready after the configured number of polls", async () => {
    const service = makeService();
    const envelope = await service.startSession({ tenantId: "tenant_a" });
    const polled = await service.getStatus(envelope.sessionId);
    expect(polled.containerStatus).toBe("ready");
  });

  it("finalizes a handoff envelope that mirrors the transcript and facts", async () => {
    const service = makeService();
    const envelope = await service.startSession({ tenantId: "tenant_a" });
    await service.sendMessage({
      sessionId: envelope.sessionId,
      message: "Shaw",
    });
    await service.getStatus(envelope.sessionId);
    const handoff = await service.finalizeHandoff({
      sessionId: envelope.sessionId,
      containerId: "container_xyz",
    });
    expect(handoff.containerId).toBe("container_xyz");
    expect(handoff.tenantId).toBe("tenant_a");
    expect(handoff.transcript.length).toBeGreaterThan(0);
    expect(handoff.facts.length).toBeGreaterThan(0);
    expect(handoff.memoryIds).toEqual(handoff.transcript.map((m) => m.id));
  });

  it("refuses to finalize while the container is still provisioning", async () => {
    const service = new MockCloudSetupSessionService({ provisioningTurns: 10 });
    const envelope = await service.startSession({ tenantId: "tenant_b" });
    await expect(
      service.finalizeHandoff({
        sessionId: envelope.sessionId,
        containerId: "c",
      }),
    ).rejects.toThrow(/provisioning/);
  });

  it("cancels and forgets the session", async () => {
    const service = makeService();
    const envelope = await service.startSession({ tenantId: "tenant_a" });
    await service.cancel(envelope.sessionId);
    await expect(service.getStatus(envelope.sessionId)).rejects.toThrow(
      /unknown/,
    );
  });
});
