/**
 * Exercises the real in-memory session manager with deterministic clocks and
 * executors. Platform drivers are replaced at the manager's explicit adapter
 * seam; lifecycle, lease, sequencing, isolation, and event state are real.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ComputerUseSessionError,
  ComputerUseSessionManager,
} from "./session-manager.js";
import type {
  ComputerUseSessionAction,
  ComputerUseSessionExecutor,
} from "./types.js";

function action(
  actionId: string,
  expectedSequence: number,
  overrides: Partial<ComputerUseSessionAction> = {},
): ComputerUseSessionAction {
  return {
    actionId,
    expectedSequence,
    command: "get_cursor_position",
    parameters: { coordinate: [10, 20], displayId: 7 },
    ...overrides,
  };
}

describe("ComputerUseSessionManager", () => {
  it("serializes physical host ownership and releases it on close", () => {
    let id = 0;
    const manager = new ComputerUseSessionManager({
      idFactory: () => `session-${++id}`,
      executor: async () => ({ success: true }),
    });
    const first = manager.create({ target: { kind: "host" } });
    expect(() => manager.create({ target: { kind: "host" } })).toThrow(
      new ComputerUseSessionError(
        "HOST_LEASE_CONFLICT",
        `Physical host input is leased by session ${first.id}`,
      ),
    );

    manager.close(first.id);
    const second = manager.create({ target: { kind: "host" } });
    expect(second.id).not.toBe(first.id);
  });

  it("keeps the host lease renewable after a different session closes", () => {
    let now = Date.parse("2026-08-19T00:00:00.000Z");
    let id = 0;
    const manager = new ComputerUseSessionManager({
      now: () => now,
      idFactory: () => `session-${++id}`,
      executor: async () => ({ success: true }),
    });
    const host = manager.create({
      target: { kind: "host" },
      leaseTtlMs: 5_000,
    });
    const isolated = manager.create({
      target: { kind: "browser", targetId: "browser-one" },
    });

    manager.close(isolated.id);
    now += 2_000;
    expect(manager.renewHostLease(host.id, 5_000).leaseExpiresAt).toBe(
      "2026-08-19T00:00:07.000Z",
    );
    now += 5_001;

    expect(manager.get(host.id)?.status).toBe("closed");
    expect(manager.create({ target: { kind: "host" } }).status).toBe("idle");
  });

  it("expires and renews host leases deterministically", () => {
    let now = Date.parse("2026-08-19T00:00:00.000Z");
    let id = 0;
    const manager = new ComputerUseSessionManager({
      now: () => now,
      idFactory: () => `session-${++id}`,
      executor: async () => ({ success: true }),
    });
    const host = manager.create({
      target: { kind: "host" },
      leaseTtlMs: 5_000,
    });
    now += 2_000;
    expect(manager.renewHostLease(host.id, 10_000).leaseExpiresAt).toBe(
      "2026-08-19T00:00:12.000Z",
    );
    now += 10_001;
    expect(manager.get(host.id)?.status).toBe("closed");
    expect(manager.create({ target: { kind: "host" } }).status).toBe("idle");
  });

  it("does not release an expired physical lease while its action is in flight", async () => {
    let now = Date.parse("2026-08-19T00:00:00.000Z");
    let id = 0;
    let release: (() => void) | undefined;
    const manager = new ComputerUseSessionManager({
      now: () => now,
      idFactory: () => `session-${++id}`,
      executor: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { success: true };
      },
    });
    const host = manager.create({
      target: { kind: "host" },
      leaseTtlMs: 5_000,
    });
    const running = manager.execute(host.id, action("action-one", 0));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    now += 5_001;

    expect(manager.get(host.id)?.status).toBe("running");
    expect(() => manager.create({ target: { kind: "host" } })).toThrow(
      "Physical host input is leased",
    );
    release?.();
    expect((await running).session.status).toBe("closed");
    expect(manager.create({ target: { kind: "host" } }).status).toBe("idle");
  });

  it("allows concurrent isolated sessions without cursor leakage", async () => {
    let id = 0;
    const releases = new Map<string, () => void>();
    const executor: ComputerUseSessionExecutor = async (target) => {
      await new Promise<void>((resolve) => {
        releases.set(target.targetId ?? "host", resolve);
      });
      return {
        success: true,
        cursorPosition:
          target.targetId === "browser-a" ? { x: 11, y: 12 } : { x: 91, y: 92 },
      };
    };
    const manager = new ComputerUseSessionManager({
      idFactory: () => `session-${++id}`,
      executor,
    });
    const first = manager.create({
      target: { kind: "browser", targetId: "browser-a" },
    });
    const second = manager.create({
      target: { kind: "sandbox", targetId: "sandbox-b" },
    });

    const firstRun = manager.execute(first.id, action("action-a", 0));
    const secondRun = manager.execute(second.id, action("action-b", 0));
    await vi.waitFor(() => {
      expect(releases.get("browser-a")).toBeTypeOf("function");
      expect(releases.get("sandbox-b")).toBeTypeOf("function");
    });
    expect(manager.get(first.id)?.status).toBe("running");
    expect(manager.get(second.id)?.status).toBe("running");
    releases.get("browser-a")?.();
    releases.get("sandbox-b")?.();
    await Promise.all([firstRun, secondRun]);

    expect(manager.get(first.id)?.cursor).toMatchObject({ x: 11, y: 12 });
    expect(manager.get(second.id)?.cursor).toMatchObject({ x: 91, y: 92 });
  });

  it("prevents two sessions from driving the same isolated target", () => {
    let id = 0;
    const manager = new ComputerUseSessionManager({
      idFactory: () => `session-${++id}`,
      executor: async () => ({ success: true }),
    });
    const first = manager.create({
      target: { kind: "browser", targetId: "profile-one" },
    });
    expect(() =>
      manager.create({
        target: { kind: "browser", targetId: "profile-one" },
      }),
    ).toThrow(
      new ComputerUseSessionError(
        "TARGET_LEASE_CONFLICT",
        `Computer-use target is leased by session ${first.id}`,
      ),
    );
  });

  it("fails closed on stale sequence, duplicate ids, and same-session overlap", async () => {
    let release: (() => void) | undefined;
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { success: true };
      },
    });
    const session = manager.create({
      target: { kind: "browser", targetId: "browser-one" },
    });
    const running = manager.execute(session.id, action("action-one", 0));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(
      manager.execute(session.id, action("action-two", 0)),
    ).rejects.toMatchObject({ code: "SESSION_BUSY" });
    release?.();
    await running;
    await expect(
      manager.execute(session.id, action("action-two", 0)),
    ).rejects.toMatchObject({ code: "STALE_SESSION_SEQUENCE" });
    await expect(
      manager.execute(session.id, action("action-one", 1)),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACTION_ID" });
  });

  it("tracks path endpoints as virtual cursors and omits action parameters from events", async () => {
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      maxEvents: 3,
      executor: async () => ({ success: true }),
      frameProvider: async () => ({ mimeType: "image/png", data: "cG5n" }),
    });
    const session = manager.create({
      label: "background browser",
      target: {
        kind: "browser",
        targetId: "browser-one",
        viewerUrl: "https://user:secret@example.test/vnc?token=secret#fragment",
      },
    });
    const frame = await manager.captureFrame(session.id);
    const completed = await manager.execute(
      session.id,
      action("action-one", 0, {
        command: "drag",
        observationId: frame.provenance.observationId,
        observationSequence: frame.provenance.sequence,
        parameters: {
          path: [
            [1, 2],
            [30, 40],
          ],
          displayId: 3,
          text: "must-not-enter-event-history",
        },
      }),
    );
    expect(completed.session.cursor).toMatchObject({
      x: 30,
      y: 40,
      displayId: 3,
    });
    expect(completed.session.target.viewerUrl).toBe("https://example.test/vnc");
    const serialized = JSON.stringify(manager.getEvents());
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("must-not-enter-event-history");
    expect(manager.getEvents()).toHaveLength(3);
  });

  it("rejects cleartext non-loopback viewer endpoints", () => {
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => ({ success: true }),
    });
    expect(() =>
      manager.create({
        target: {
          kind: "sandbox",
          targetId: "sandbox-one",
          viewerUrl: "http://viewer.example/vnc",
        },
      }),
    ).toThrow("viewerUrl must use HTTPS unless it is loopback");
  });

  it("accepts cleartext IPv6 loopback viewer endpoints", () => {
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => ({ success: true }),
    });
    const session = manager.create({
      target: {
        kind: "sandbox",
        targetId: "sandbox-one",
        viewerUrl: "http://[::1]:6080/vnc?token=secret#viewer",
      },
    });
    expect(session.target.viewerUrl).toBe("http://[::1]:6080/vnc");
  });

  it("captures frames without consuming action sequence or retaining bytes", async () => {
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => ({ success: true }),
      frameProvider: async () => ({ mimeType: "image/png", data: "cG5n" }),
    });
    const session = manager.create({
      target: { kind: "browser", targetId: "browser-one" },
    });
    const frame = await manager.captureFrame(session.id);
    expect(frame).toMatchObject({ mimeType: "image/png", data: "cG5n" });
    expect(frame.provenance).toMatchObject({
      observationId: "session-one:observation:1",
      sequence: 1,
      source: "browser",
      sha256:
        "8f8cbb7dcf46e0bc7d53265749a6c17d116093a6ba95e442764060c76fd4a86c",
    });
    expect(manager.get(session.id)?.sequence).toBe(0);
    expect(JSON.stringify(manager.getEvents())).not.toContain("cG5n");
  });

  it("rejects missing, wrong-target, stale, and repeated observation-bound actions", async () => {
    let id = 0;
    const manager = new ComputerUseSessionManager({
      idFactory: () => `session-${++id}`,
      executor: async () => ({ success: true }),
      frameProvider: async () => ({ mimeType: "image/png", data: "cG5n" }),
    });
    const first = manager.create({ target: { kind: "host" } });

    await expect(
      manager.execute(first.id, action("missing", 0, { command: "click" })),
    ).rejects.toMatchObject({ code: "STALE_OBSERVATION" });

    const firstFrame = await manager.captureFrame(first.id);
    await expect(
      manager.execute(
        first.id,
        action("wrong", 0, {
          command: "click",
          observationId: "another-session:observation:1",
          observationSequence: firstFrame.provenance.sequence,
        }),
      ),
    ).rejects.toMatchObject({ code: "STALE_OBSERVATION" });

    await manager.execute(
      first.id,
      action("accepted", 0, {
        command: "click",
        observationId: firstFrame.provenance.observationId,
        observationSequence: firstFrame.provenance.sequence,
      }),
    );
    await expect(
      manager.execute(
        first.id,
        action("consumed", 1, {
          command: "click",
          observationId: firstFrame.provenance.observationId,
          observationSequence: firstFrame.provenance.sequence,
        }),
      ),
    ).rejects.toMatchObject({ code: "STALE_OBSERVATION" });

    const unchangedFrame = await manager.captureFrame(first.id);
    await expect(
      manager.execute(
        first.id,
        action("repeat", 1, {
          command: "click",
          observationId: unchangedFrame.provenance.observationId,
          observationSequence: unchangedFrame.provenance.sequence,
        }),
      ),
    ).rejects.toMatchObject({ code: "REPEATED_ACTION_GUARD" });
  });

  it("normalizes compatibility actions through the canonical core authority", async () => {
    let executed = false;
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => {
        executed = true;
        return { success: true };
      },
      frameProvider: async () => ({ mimeType: "image/png", data: "cG5n" }),
    });
    const session = manager.create({ target: { kind: "host" } });
    const frame = await manager.captureFrame(session.id);

    await expect(
      manager.execute(
        session.id,
        action("invalid-canonical-pointer", 0, {
          command: "click",
          parameters: {},
          observationId: frame.provenance.observationId,
          observationSequence: frame.provenance.sequence,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_SESSION_INPUT" });
    expect(executed).toBe(false);
  });

  it("pauses, resumes, and aborts an in-flight action on stop", async () => {
    let release: (() => void) | undefined;
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async (_target, _action, signal) => {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return { success: true };
      },
    });
    const session = manager.create({
      target: { kind: "browser", targetId: "fixture" },
    });
    expect(manager.pause(session.id)).toMatchObject({
      status: "paused",
      canonicalState: "paused",
    });
    await expect(
      manager.execute(session.id, action("paused", 0)),
    ).rejects.toMatchObject({ code: "SESSION_PAUSED" });
    manager.resume(session.id);
    const running = manager.execute(session.id, action("running", 0));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(manager.stop(session.id)).toMatchObject({
      status: "stopping",
      canonicalState: "stopping",
    });
    await expect(running).rejects.toThrow("stopped by its owner");
    expect(manager.get(session.id)).toMatchObject({
      status: "closed",
      canonicalState: "stopped",
      lastOutcome: { status: "FAILED_NO_EFFECT", errorCode: "CANCELLED" },
    });
    release?.();
  });

  it("redacts adapter failures from shared state and releases the busy state", async () => {
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => {
        throw new Error("adapter unavailable token=must-not-leak");
      },
    });
    const session = manager.create({
      target: { kind: "remote_guest", targetId: "guest-one" },
    });
    await expect(
      manager.execute(session.id, action("action-one", 0)),
    ).rejects.toThrow("adapter unavailable token=must-not-leak");
    expect(manager.get(session.id)).toMatchObject({
      status: "idle",
      sequence: 1,
      lastError: "Computer-use action failed",
    });
    expect(manager.getEvents().at(-1)?.type).toBe("action.failed");
    expect(JSON.stringify(manager.getEvents())).not.toContain("must-not-leak");
  });

  it("surfaces OS permission denial as a policy-blocked typed outcome", async () => {
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => ({
        success: false,
        error: "Accessibility permission is required",
        permissionDenied: true,
        permissionType: "accessibility",
      }),
      frameProvider: async () => ({ mimeType: "image/png", data: "cG5n" }),
    });
    const session = manager.create({ target: { kind: "host" } });
    const frame = await manager.captureFrame(session.id);
    const result = await manager.execute(
      session.id,
      action("permission-denied", 0, {
        command: "click",
        observationId: frame.provenance.observationId,
        observationSequence: frame.provenance.sequence,
      }),
    );
    expect(result.session.lastOutcome).toMatchObject({
      status: "BLOCKED_BY_POLICY",
      errorCode: "ACCESSIBILITY_PERMISSION_DENIED",
    });
  });

  it("automatically captures a fresh verification observation after an app action", async () => {
    let frameNumber = 0;
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => ({
        success: true,
        data: {
          receipt: {
            receiptId: "receipt-one",
            appId: "fixture.app",
            kind: "click",
            beforeStateId: "fixture.app:before",
            afterStateId: "fixture.app:after",
            executionMode: "semantic_ax",
            completedAt: "2026-08-23T00:00:01.000Z",
            effectStatus: "confirmed",
            changed: true,
            physicalPointerMoved: false,
            element_index: 3,
            targetBounds: { x: 40, y: 50, width: 60, height: 30 },
          },
        },
      }),
      frameProvider: async () => ({
        mimeType: "image/png",
        data: Buffer.from(`frame-${++frameNumber}`).toString("base64"),
      }),
    });
    const session = manager.create({ target: { kind: "host" } });
    const before = await manager.captureFrame(session.id);
    const completed = await manager.execute(
      session.id,
      action("app-click", 0, {
        command: "app_click",
        parameters: {
          app: "fixture.app",
          stateId: "fixture.app:before",
          element_index: 3,
        },
        observationId: before.provenance.observationId,
        observationSequence: before.provenance.sequence,
      }),
    );

    expect(completed.result.verificationObservation).toMatchObject({
      observationId: "session-one:observation:2",
      sequence: 2,
    });
    expect(completed.session.lastOutcome?.observationId).toBe(
      "session-one:observation:2",
    );
    expect(completed.session.lastReceipt).toMatchObject({
      executionMode: "semantic_ax",
      physicalPointerMoved: false,
    });
    expect(completed.session.targetOverlay).toMatchObject({
      x: 40,
      y: 50,
      width: 60,
      height: 30,
      elementIndex: 3,
      physicalPointerMoved: false,
    });
  });

  it("reports uncertain effect when post-action fresh-frame verification fails", async () => {
    let frameNumber = 0;
    const manager = new ComputerUseSessionManager({
      idFactory: () => "session-one",
      executor: async () => ({ success: true }),
      frameProvider: async () => {
        frameNumber += 1;
        if (frameNumber === 1) return { mimeType: "image/png", data: "cG5n" };
        throw new Error("fixture capture unavailable");
      },
    });
    const session = manager.create({ target: { kind: "host" } });
    const before = await manager.captureFrame(session.id);
    const completed = await manager.execute(
      session.id,
      action("click", 0, {
        command: "click",
        observationId: before.provenance.observationId,
        observationSequence: before.provenance.sequence,
      }),
    );
    expect(completed.result).toMatchObject({
      success: false,
      outcomeStatus: "UNCERTAIN_EFFECT",
      errorCode: "FRESH_VERIFICATION_FAILED",
    });
    expect(completed.session.lastOutcome).toMatchObject({
      status: "UNCERTAIN_EFFECT",
      errorCode: "FRESH_VERIFICATION_FAILED",
    });
  });
});
