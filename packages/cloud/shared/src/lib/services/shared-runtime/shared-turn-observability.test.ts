/** Deterministic boundary tests for privacy-safe shared-turn measurement fields. */

import { describe, expect, spyOn, test } from "bun:test";
import {
  classifyBridgeRequestMethod,
  classifySharedTurnOutcome,
  classifySharedTurnRpcMethod,
  readSharedTurnAttemptContext,
  recordSharedTurnAttempt,
  SHARED_TURN_ATTEMPT_HEADER,
  SHARED_TURN_CORRELATION_HEADER,
} from "./shared-turn-observability";

const TURN = "123e4567-e89b-42d3-a456-426614174000";

describe("shared-turn observability", () => {
  test("accepts only a bounded opaque UUID and attempt ordinal", () => {
    const headers = new Headers({
      [SHARED_TURN_CORRELATION_HEADER]: TURN.toUpperCase(),
      [SHARED_TURN_ATTEMPT_HEADER]: "2",
    });
    expect(readSharedTurnAttemptContext(headers)).toEqual({
      logicalTurn: TURN,
      attempt: 2,
      attemptKind: "retry",
    });
  });

  test("rejects arbitrary correlation text and unbounded attempts", () => {
    const headers = new Headers({
      [SHARED_TURN_CORRELATION_HEADER]: "user@example.com hello",
      [SHARED_TURN_ATTEMPT_HEADER]: "101",
    });
    expect(readSharedTurnAttemptContext(headers)).toEqual({
      logicalTurn: null,
      attempt: null,
      attemptKind: "unknown",
    });
  });

  test("allow-lists bridge methods instead of logging arbitrary caller text", async () => {
    expect(classifySharedTurnRpcMethod("message.send")).toBe("message.send");
    expect(classifySharedTurnRpcMethod("private caller text")).toBe("other");
    expect(classifySharedTurnRpcMethod(null)).toBe("invalid");
    const request = new Request("https://api.test/bridge", {
      method: "POST",
      body: JSON.stringify({ method: "status.get" }),
    });
    expect(await classifyBridgeRequestMethod(request)).toBe("status.get");
    expect(await request.json()).toEqual({ method: "status.get" });
  });

  test("bounds bridge method inspection without consuming the dispatched request", async () => {
    const request = new Request("https://api.test/bridge", {
      method: "POST",
      body: JSON.stringify({
        method: "message.send",
        params: { text: "x".repeat(65 * 1024) },
      }),
    });
    expect(await classifyBridgeRequestMethod(request)).toBe("invalid");
    expect(await request.json()).toMatchObject({ method: "message.send" });
  });

  test("classifies only named warming outcomes from error responses", async () => {
    const warming = Response.json(
      { code: "shared_runtime_cache_warming", secret: "not logged" },
      { status: 503 },
    );
    expect(await classifySharedTurnOutcome(warming)).toBe("shared_runtime_cache_warming");
    expect(await warming.json()).toMatchObject({
      code: "shared_runtime_cache_warming",
    });
    expect(
      await classifySharedTurnOutcome(
        Response.json({ code: "private-arbitrary-code" }, { status: 503 }),
      ),
    ).toBe("other_error");
    expect(await classifySharedTurnOutcome(new Response("ok"))).toBe("success");
    expect(
      await classifySharedTurnOutcome(
        Response.json(
          { code: "shared_runtime_cache_warming", padding: "x".repeat(17 * 1024) },
          { status: 503 },
        ),
      ),
    ).toBe("other_error");
  });

  test("emits one queryable record without request payload or arbitrary headers", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      recordSharedTurnAttempt({
        headers: new Headers({
          [SHARED_TURN_CORRELATION_HEADER]: TURN,
          [SHARED_TURN_ATTEMPT_HEADER]: "1",
          Authorization: "Bearer must-not-log",
          "X-Private-Text": "must-not-log",
        }),
        traceId: "11111111-1111-4111-8111-111111111111",
        durationMs: 123.456,
        surface: "stream",
        rpcMethod: "message.send",
        runtimeKind: "personal",
        status: 503,
        outcome: "shared_runtime_cache_warming",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual([
        "[shared-turn baseline] request completed",
        {
          traceId: "11111111-1111-4111-8111-111111111111",
          durationMs: 123.46,
          surface: "stream",
          rpcMethod: "message.send",
          runtimeKind: "personal",
          status: 503,
          outcome: "shared_runtime_cache_warming",
          logicalTurn: TURN,
          attempt: 1,
          attemptKind: "first",
        },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-log");
    } finally {
      warn.mockRestore();
    }
  });

  test("does not retain arbitrary trace text or invalid durations", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      recordSharedTurnAttempt({
        headers: new Headers(),
        traceId: "user@example.com private trace text",
        durationMs: Number.POSITIVE_INFINITY,
        surface: "bridge",
        rpcMethod: "other",
        runtimeKind: "unresolved",
        status: 500,
        outcome: "other_error",
      });
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        traceId: "unavailable",
        durationMs: null,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private trace text");
    } finally {
      warn.mockRestore();
    }
  });
});
