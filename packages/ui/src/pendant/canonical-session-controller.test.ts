// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CanonicalPendantSessionController } from "./canonical-session-controller";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";

function snapshot(revision = 0) {
  return {
    schemaVersion: 1 as const,
    session: {
      id: "session-1",
      ownerId: "owner",
      agentId: "agent",
      startedAt: "2026-08-04T00:00:00.000Z",
      endedAt: null,
      state: "active" as const,
      captureLease: null,
      processingLocation: "cloud" as const,
      revision,
    },
    segments: [],
    insightRefs: [],
  };
}

function detail(
  status: "pending" | "resolved",
): PendantTranscriptSegmentDetail {
  return {
    id: "local-1",
    status,
    text: status === "resolved" ? "canonical words" : undefined,
    startedAt: Date.parse("2026-08-04T00:00:00.000Z"),
    endedAt: Date.parse("2026-08-04T00:00:01.000Z"),
    durationMs: 1000,
    words: [],
  };
}

function harness() {
  const order: string[] = [];
  const client = {
    unsyncedQueue: [],
    createSession: vi.fn(async () => snapshot()),
    acquireLease: vi.fn(async () => ({
      ok: true as const,
      session: snapshot().session,
      leaseToken: "lease",
    })),
    appendSegment: vi.fn(async () => {
      order.push("append");
      return snapshot(2);
    }),
    patchSegment: vi.fn(async () => {
      order.push("patch");
      return snapshot(3);
    }),
    pause: vi.fn(async () => snapshot(4)),
    resume: vi.fn(async () => snapshot(5)),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    discardUnsyncedMutation: vi.fn(),
  };
  const controller = new CanonicalPendantSessionController({
    client: client as never,
    holder: "device",
    onSnapshot: vi.fn(),
    onError: (error) => {
      throw error;
    },
  });
  return { client, controller, order };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CanonicalPendantSessionController", () => {
  it("emits VOICE_DM only after the canonical resolved patch commits", async () => {
    const h = harness();
    window.addEventListener("eliza:pendant:voice-transcript", () =>
      h.order.push("voice"),
    );
    await h.controller.start();
    h.controller.handleSegment(detail("pending"));
    h.controller.handleSegment(detail("resolved"));
    await settle();

    expect(h.order).toEqual(["append", "patch", "voice"]);
    expect(h.client.appendSegment).toHaveBeenCalledTimes(1);
    expect(h.client.patchSegment).toHaveBeenCalledWith(
      "session-1",
      "session-1:segment:0",
      expect.objectContaining({ status: "resolved", text: "canonical words" }),
    );
  });

  it("drops queued capture writes when pause advances the generation", async () => {
    const h = harness();
    await h.controller.start();
    h.controller.handleSegment(detail("pending"));
    h.controller.handleSegment(detail("resolved"));
    h.controller.pause();
    await settle();

    expect(h.client.pause).toHaveBeenCalledWith("session-1");
    expect(h.client.appendSegment).not.toHaveBeenCalled();
    expect(h.client.patchSegment).not.toHaveBeenCalled();
    expect(h.order).toEqual([]);
  });

  it("does not publish an append snapshot that resolves after pause", async () => {
    const h = harness();
    let resolveAppend:
      | ((pendingSnapshot: ReturnType<typeof snapshot>) => void)
      | undefined;
    h.client.appendSegment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAppend = resolve;
        }),
    );
    const onSnapshot = vi.fn();
    const controller = new CanonicalPendantSessionController({
      client: h.client as never,
      holder: "device",
      onSnapshot,
      onError: (error) => {
        throw error;
      },
    });

    await controller.start();
    onSnapshot.mockClear();
    controller.handleSegment(detail("pending"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.pause();
    if (!resolveAppend) throw new Error("append did not start");
    resolveAppend(snapshot(2));
    await settle();

    expect(h.client.pause).toHaveBeenCalledWith("session-1");
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("severs snapshot delivery while paused and resumes the canonical session", async () => {
    const h = harness();
    await h.controller.start();

    h.controller.pause();
    expect(h.controller.acceptsSnapshot(snapshot(4))).toBe(false);
    await h.controller.resume();

    expect(h.client.createSession).toHaveBeenCalledTimes(1);
    expect(h.client.resume).toHaveBeenCalledWith("session-1");
    expect(h.client.startPolling).toHaveBeenLastCalledWith("session-1");
    expect(h.controller.acceptsSnapshot(snapshot(6))).toBe(true);
  });
});
