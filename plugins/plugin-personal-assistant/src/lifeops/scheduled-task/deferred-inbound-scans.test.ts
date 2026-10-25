/**
 * Unit coverage for the deferred-inbound-scan seam: that `detachInboundScan`
 * resolves the awaited MESSAGE_RECEIVED edge without waiting for the scan, that
 * a rejecting scan routes to `runtime.reportError` instead of rejecting the
 * edge, and that `settleDeferredInboundScans` drains chained scans. The runtime
 * here is a minimal recording stand-in for `reportError` only — the seam itself
 * (scheduling, tracking, draining) is exercised for real.
 */

import {
  type IAgentRuntime,
  type Memory,
  type MessagePayload,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  detachInboundScan,
  settleDeferredInboundScans,
} from "./deferred-inbound-scans.js";

interface ReportedError {
  scope: string;
  error: unknown;
  context?: Record<string, unknown>;
}

/** Minimal runtime exposing only the `reportError` collaborator the seam uses. */
function recordingRuntime(): {
  runtime: IAgentRuntime;
  reported: ReportedError[];
} {
  const reported: ReportedError[] = [];
  const runtime = {
    reportError(
      scope: string,
      error: unknown,
      context?: Record<string, unknown>,
    ) {
      reported.push({ scope, error, context });
    },
  } as unknown as IAgentRuntime;
  return { runtime, reported };
}

function payloadFor(
  runtime: IAgentRuntime,
  overrides?: { roomId?: UUID; messageId?: UUID },
): MessagePayload {
  const message = {
    id: overrides?.messageId ?? stringToUuid("deferred-scan-msg"),
    entityId: stringToUuid("deferred-scan-owner"),
    roomId: overrides?.roomId ?? stringToUuid("deferred-scan-room"),
    content: { text: "done!" },
    createdAt: Date.now(),
  } as unknown as Memory;
  return { runtime, message, source: "test" } as MessagePayload;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("detachInboundScan", () => {
  it("resolves the awaited edge without waiting for a slow scan, but still runs it", async () => {
    const { runtime } = recordingRuntime();
    let scanRan = false;
    const handler = detachInboundScan("slow", async () => {
      await sleep(1500);
      scanRan = true;
    });

    const startedAt = Date.now();
    await handler(payloadFor(runtime));
    const awaitedEdgeMs = Date.now() - startedAt;

    // The awaited edge must return effectively immediately — the 1500ms scan
    // is off the critical path (#15255).
    expect(awaitedEdgeMs).toBeLessThan(200);
    expect(scanRan).toBe(false);

    await settleDeferredInboundScans();
    expect(scanRan).toBe(true);
  });

  it("routes a scan failure to runtime.reportError and never rejects the awaited edge", async () => {
    const { runtime, reported } = recordingRuntime();
    const roomId = stringToUuid("deferred-scan-room-fail");
    const messageId = stringToUuid("deferred-scan-msg-fail");
    const failure = new Error("store down");
    const handler = detachInboundScan("inbound-reply-completion", async () => {
      throw failure;
    });

    // The awaited edge resolves even though the scan throws.
    await expect(
      handler(payloadFor(runtime, { roomId, messageId })),
    ).resolves.toBeUndefined();

    await settleDeferredInboundScans();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toEqual({
      scope: "lifeops:inbound-scan:inbound-reply-completion",
      error: failure,
      context: { roomId, messageId },
    });
  });

  it("routes a synchronous scan throw to runtime.reportError off the awaited edge", async () => {
    const { runtime, reported } = recordingRuntime();
    const failure = new Error("missing store");
    const handler = detachInboundScan("sync-throw", () => {
      throw failure;
    });

    await expect(handler(payloadFor(runtime))).resolves.toBeUndefined();
    await settleDeferredInboundScans();

    expect(reported).toHaveLength(1);
    expect(reported[0]?.scope).toBe("lifeops:inbound-scan:sync-throw");
    expect(reported[0]?.error).toBe(failure);
  });

  it("settle drains a scan that schedules another scan while it runs", async () => {
    const { runtime } = recordingRuntime();
    let innerRan = false;
    const outer = detachInboundScan("outer", async () => {
      // Schedule a second detached scan mid-flight; it outlives the outer scan.
      const inner = detachInboundScan("inner", async () => {
        await sleep(100);
        innerRan = true;
      });
      await inner(payloadFor(runtime));
    });

    await outer(payloadFor(runtime));
    // The chained inner scan is still pending here; settle must loop to catch it.
    await settleDeferredInboundScans();
    expect(innerRan).toBe(true);
  });
});
