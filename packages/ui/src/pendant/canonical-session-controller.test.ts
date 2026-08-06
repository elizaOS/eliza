// @vitest-environment jsdom
import type { PendantSessionSnapshot } from "@elizaos/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import { CanonicalPendantSessionController } from "./canonical-session-controller";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";

function snapshot(revision = 0): PendantSessionSnapshot {
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
    currentSnapshot: null,
    discoverCurrentSession: vi.fn<() => Promise<PendantSessionSnapshot | null>>(
      async () => null,
    ),
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
    end: vi.fn(async () => ({
      ...snapshot(6),
      session: { ...snapshot(6).session, state: "ended" as const },
    })),
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
  it("discovers the owner current session without taking its capture lease", async () => {
    const h = harness();
    h.client.discoverCurrentSession.mockResolvedValueOnce(snapshot(7));

    const discovered = await h.controller.followLatest();

    expect(discovered?.session.id).toBe("session-1");
    expect(h.client.createSession).not.toHaveBeenCalled();
    expect(h.client.acquireLease).not.toHaveBeenCalled();
    expect(h.client.startPolling).toHaveBeenCalledWith("session-1");
    expect(h.controller.acceptsSnapshot(snapshot(8))).toBe(true);
  });

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

  it("serializes pause completion before resume begins", async () => {
    const h = harness();
    let resolvePause:
      | ((pausedSnapshot: ReturnType<typeof snapshot>) => void)
      | undefined;
    h.client.pause.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePause = resolve;
        }),
    );
    await h.controller.start();

    const pausing = h.controller.pause();
    await Promise.resolve();
    const resuming = h.controller.resume();
    await Promise.resolve();
    expect(h.client.resume).not.toHaveBeenCalled();

    if (!resolvePause) throw new Error("pause did not start");
    resolvePause(snapshot(4));
    await pausing;
    await resuming;

    expect(h.client.pause).toHaveBeenCalledBefore(h.client.resume);
  });

  it("ends an owned server session when capture stops", async () => {
    const h = harness();
    await h.controller.start();

    await h.controller.stop();

    expect(h.client.stopPolling).toHaveBeenCalled();
    expect(h.client.end).toHaveBeenCalledWith("session-1");
    expect(h.controller.acceptsSnapshot(snapshot(7))).toBe(false);
  });

  it("renews the capture lease before it expires", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.controller.start();
      expect(h.client.acquireLease).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(45_000);

      expect(h.client.acquireLease).toHaveBeenCalledTimes(2);
      expect(h.client.acquireLease).toHaveBeenLastCalledWith(
        "session-1",
        expect.objectContaining({
          holder: "device",
          leaseToken: "lease",
          leaseMs: 60_000,
        }),
      );
      await h.controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
