/**
 * Unit tests for the `CloudSetupSessionService` contract: the five operations
 * and their input/result types, driven through the real
 * `MockCloudSetupSessionService` reference implementation. Deterministic clock
 * and id generation; no mocked return values.
 */

import { describe, expect, it } from "vitest";
import { MockCloudSetupSessionService } from "../mock-service.js";
import type {
  CloudSetupSessionService,
  FinalizeHandoffInput,
  SendMessageInput,
  SendMessageResult,
  StartSessionInput,
} from "../service-interface.js";

function makeService(provisioningTurns = 1): CloudSetupSessionService {
  let counter = 0;
  return new MockCloudSetupSessionService({
    now: () => 1_000_000 + counter,
    randomId: () => `id_${++counter}`,
    provisioningTurns,
  });
}

describe("service-interface module", () => {
  it("is a types-only ESM module with no runtime exports", async () => {
    const mod = await import("../service-interface.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});

describe("CloudSetupSessionService.startSession", () => {
  it("accepts StartSessionInput and returns a provisioning envelope", async () => {
    const service: CloudSetupSessionService = makeService();
    const input: StartSessionInput = { tenantId: "tenant_a" };
    const envelope = await service.startSession(input);
    expect(envelope.tenantId).toBe("tenant_a");
    expect(envelope.containerStatus).toBe("provisioning");
    expect(envelope.sessionId).toBe("id_1");
    expect(envelope.containerId).toBe("id_2");
    // randomId runs twice (sessionId, containerId) before now() is read.
    expect(envelope.createdAt).toBe(1_000_002);
  });

  it("accepts an empty tenantId string rather than inventing a default", async () => {
    const service = makeService();
    const input: StartSessionInput = { tenantId: "" };
    const envelope = await service.startSession(input);
    expect(envelope.tenantId).toBe("");
  });

  it("issues independent session ids for two starts with the same tenant", async () => {
    const service = makeService();
    const first = await service.startSession({ tenantId: "shared" });
    const second = await service.startSession({ tenantId: "shared" });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.tenantId).toBe("shared");
    expect(second.tenantId).toBe("shared");
  });

  it("returns a copy so mutating the envelope does not change stored status", async () => {
    const service = makeService();
    const envelope = await service.startSession({ tenantId: "tenant_a" });
    envelope.containerStatus = "failed";
    const stored = await service.getStatus(envelope.sessionId);
    expect(stored.containerStatus).not.toBe("failed");
  });
});

describe("CloudSetupSessionService.sendMessage", () => {
  it("returns SendMessageResult replies and owner.name on the first turn", async () => {
    const service = makeService();
    const started = await service.startSession({ tenantId: "tenant_a" });
    const input: SendMessageInput = {
      sessionId: started.sessionId,
      message: "Shaw",
    };
    const result: SendMessageResult = await service.sendMessage(input);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.role).toBe("agent");
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.key).toBe("owner.name");
    expect(result.facts[0]?.value).toBe("Shaw");
    expect(result.facts[0]?.source).toBe("user");
    expect(result.facts[0]?.confidence).toBe(0.6);
  });

  it("extracts owner.language on the second turn and empty facts after that", async () => {
    const service = makeService();
    const started = await service.startSession({ tenantId: "tenant_a" });
    await service.sendMessage({
      sessionId: started.sessionId,
      message: "Shaw",
    });
    const language = await service.sendMessage({
      sessionId: started.sessionId,
      message: "English",
    });
    expect(language.facts).toHaveLength(1);
    expect(language.facts[0]?.key).toBe("owner.language");
    expect(language.facts[0]?.value).toBe("English");
    expect(language.facts[0]?.confidence).toBe(0.7);

    const later = await service.sendMessage({
      sessionId: started.sessionId,
      message: "next",
    });
    expect(later.facts).toEqual([]);
    expect(later.replies).toHaveLength(1);
  });

  it("records an empty message as the fact value instead of skipping the turn", async () => {
    const service = makeService();
    const started = await service.startSession({ tenantId: "tenant_a" });
    const result = await service.sendMessage({
      sessionId: started.sessionId,
      message: "",
    });
    expect(result.facts[0]?.value).toBe("");
    expect(result.replies).toHaveLength(1);
  });

  it("rejects sendMessage for a missing sessionId", async () => {
    const service = makeService();
    const input: SendMessageInput = {
      sessionId: "missing",
      message: "hello",
    };
    await expect(service.sendMessage(input)).rejects.toThrow(
      /unknown setup session: missing/,
    );
  });

  it("keeps the last tour line once turn count overflows the script", async () => {
    const service = makeService();
    const started = await service.startSession({ tenantId: "tenant_a" });
    let last = "";
    for (let turn = 0; turn < 8; turn++) {
      const result = await service.sendMessage({
        sessionId: started.sessionId,
        message: `turn-${turn}`,
      });
      last = result.replies[0]?.content ?? "";
    }
    expect(last).toBe(
      "All set. As soon as your container is ready I'll move this conversation into it.",
    );
  });
});

describe("CloudSetupSessionService.getStatus", () => {
  it("rejects getStatus for a missing sessionId", async () => {
    const service = makeService();
    await expect(service.getStatus("missing")).rejects.toThrow(
      /unknown setup session: missing/,
    );
  });

  it("stays provisioning until the configured poll count, then stays ready", async () => {
    const service = makeService(2);
    const started = await service.startSession({ tenantId: "tenant_a" });
    const first = await service.getStatus(started.sessionId);
    expect(first.containerStatus).toBe("provisioning");
    const second = await service.getStatus(started.sessionId);
    expect(second.containerStatus).toBe("ready");
    const extra = await service.getStatus(started.sessionId);
    expect(extra.containerStatus).toBe("ready");
  });

  it("isolates status polls across two sessions", async () => {
    const service = makeService(2);
    const first = await service.startSession({ tenantId: "a" });
    const second = await service.startSession({ tenantId: "b" });
    await service.getStatus(first.sessionId);
    const secondStatus = await service.getStatus(second.sessionId);
    expect(secondStatus.containerStatus).toBe("provisioning");
    const firstReady = await service.getStatus(first.sessionId);
    expect(firstReady.containerStatus).toBe("ready");
  });
});

describe("CloudSetupSessionService.finalizeHandoff", () => {
  it("rejects finalizeHandoff for a missing sessionId", async () => {
    const service = makeService();
    const input: FinalizeHandoffInput = {
      sessionId: "missing",
      containerId: "container_xyz",
    };
    await expect(service.finalizeHandoff(input)).rejects.toThrow(
      /unknown setup session: missing/,
    );
  });

  it("rejects finalizeHandoff while the container is still provisioning", async () => {
    const service = makeService(10);
    const started = await service.startSession({ tenantId: "tenant_b" });
    await expect(
      service.finalizeHandoff({
        sessionId: started.sessionId,
        containerId: "c",
      }),
    ).rejects.toThrow(/provisioning/);
  });

  it("uses FinalizeHandoffInput.containerId, not the session container id", async () => {
    const service = makeService();
    const started = await service.startSession({ tenantId: "tenant_a" });
    await service.sendMessage({
      sessionId: started.sessionId,
      message: "Shaw",
    });
    await service.getStatus(started.sessionId);
    const input: FinalizeHandoffInput = {
      sessionId: started.sessionId,
      containerId: "container_xyz",
    };
    const handoff = await service.finalizeHandoff(input);
    expect(handoff.containerId).toBe("container_xyz");
    expect(handoff.containerId).not.toBe(started.containerId);
    expect(handoff.sessionId).toBe(started.sessionId);
    expect(handoff.tenantId).toBe("tenant_a");
    expect(handoff.transcript.length).toBeGreaterThan(0);
    expect(handoff.facts.length).toBeGreaterThan(0);
    expect(handoff.memoryIds).toEqual(handoff.transcript.map((m) => m.id));
  });

  it("finalizes with an empty facts list when no messages were sent", async () => {
    const service = makeService();
    const started = await service.startSession({ tenantId: "tenant_a" });
    await service.getStatus(started.sessionId);
    const handoff = await service.finalizeHandoff({
      sessionId: started.sessionId,
      containerId: "c",
    });
    expect(handoff.facts).toEqual([]);
    expect(handoff.transcript).toHaveLength(1);
    expect(handoff.transcript[0]?.role).toBe("agent");
  });
});

describe("CloudSetupSessionService.cancel", () => {
  it("resolves void and then treats the session as missing", async () => {
    const service = makeService();
    const started = await service.startSession({ tenantId: "tenant_a" });
    const result = await service.cancel(started.sessionId);
    expect(result).toBeUndefined();
    await expect(service.getStatus(started.sessionId)).rejects.toThrow(
      /unknown setup session/,
    );
    await expect(
      service.sendMessage({
        sessionId: started.sessionId,
        message: "hi",
      }),
    ).rejects.toThrow(/unknown setup session/);
    await expect(
      service.finalizeHandoff({
        sessionId: started.sessionId,
        containerId: "c",
      }),
    ).rejects.toThrow(/unknown setup session/);
  });

  it("rejects cancel for a missing sessionId", async () => {
    const service = makeService();
    await expect(service.cancel("missing")).rejects.toThrow(
      /unknown setup session: missing/,
    );
  });

  it("does not cancel a sibling session", async () => {
    const service = makeService();
    const kept = await service.startSession({ tenantId: "keep" });
    const dropped = await service.startSession({ tenantId: "drop" });
    await service.cancel(dropped.sessionId);
    const status = await service.getStatus(kept.sessionId);
    expect(status.sessionId).toBe(kept.sessionId);
    expect(status.tenantId).toBe("keep");
  });
});
