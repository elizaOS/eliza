/** Validates application trace correlation and standards-based HTTP timing headers. */
import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

import {
  appendServerTiming,
  bindGatewayHandoffTelemetry,
  copyHttpTelemetryHeaders,
  ELIZA_AUTH_TRACE_HEADER,
  ELIZA_TRACE_ID_HEADER,
  invokeAtGatewayHandoff,
  resolveElizaTraceId,
  setGatewayPreforwardTelemetryHeaders,
  setHttpTelemetryHeaders,
  snapshotGatewayPreforwardTiming,
  withGatewayPreforwardTelemetry,
  withInferenceAuthTelemetry,
} from "./http-telemetry";

describe("HTTP telemetry", () => {
  test("preserves an opaque caller trace id", () => {
    const headers = new Headers({
      [ELIZA_TRACE_ID_HEADER]: "123E4567-E89B-42D3-A456-426614174000",
    });
    expect(resolveElizaTraceId(headers)).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  test("preserves UUIDv7 trace ids", () => {
    const headers = new Headers({
      [ELIZA_TRACE_ID_HEADER]: "01890F47-6C4A-7B2D-8F31-123456789ABC",
    });
    expect(resolveElizaTraceId(headers)).toBe("01890f47-6c4a-7b2d-8f31-123456789abc");
  });

  test("uses the W3C trace id when the application header is absent", () => {
    const headers = new Headers({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    expect(resolveElizaTraceId(headers)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  test.each([
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-abcd",
  ])("rejects invalid W3C v00 traceparent %s", (traceparent) => {
    expect(resolveElizaTraceId(new Headers({ traceparent }))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test.each([
    "bad value\n",
    "customer-email@example.com",
    "turn_12345678",
    "00000000000000000000000000000000",
  ])("rejects caller-chosen trace text %s and generates a UUID", (traceId) => {
    const headers = new Headers({ [ELIZA_TRACE_ID_HEADER]: traceId });
    expect(resolveElizaTraceId(headers)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_VALUE,
    -0.01,
  ])("rejects invalid gateway timing %s instead of fabricating zero", (invalidDuration) => {
    let thrown: unknown;
    try {
      snapshotGatewayPreforwardTiming({
        totalMs: invalidDuration,
        authMs: 1,
        middleMs: 1,
        reserveMs: 1,
        setupMs: 1,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    expect((thrown as ElizaError).code).toBe("HTTP_TELEMETRY_INVALID_DURATION");
    expect((thrown as ElizaError).context).toEqual({
      field: "totalMs",
      value: String(invalidDuration),
    });
  });

  test.each([
    Number.NaN,
    Number.MAX_VALUE,
  ])("rejects invalid standalone Server-Timing metric %s before writing headers", (invalidDuration) => {
    const headers = new Headers({ "Server-Timing": "provider;dur=3" });
    expect(() =>
      appendServerTiming(headers, [{ name: "cloud_worker", durationMs: invalidDuration }]),
    ).toThrow("HTTP telemetry duration is invalid");
    expect(headers.get("Server-Timing")).toBe("provider;dur=3");
    expect(headers.get("Server-Timing")).not.toContain("Infinity");
  });

  test("appends inner and outer Server-Timing without overwriting", () => {
    const headers = new Headers({ "Server-Timing": "agent;dur=12" });
    appendServerTiming(headers, [{ name: "cloud worker", durationMs: 8.126 }]);
    expect(headers.get("Server-Timing")).toBe("agent;dur=12, cloud_worker;dur=8.13");

    setHttpTelemetryHeaders(headers, "turn_12345678", [], "https://app.elizacloud.ai");
    expect(headers.get(ELIZA_TRACE_ID_HEADER)).toBe("turn_12345678");
    expect(headers.get("Timing-Allow-Origin")).toBe("https://app.elizacloud.ai");
  });

  test("emits one frozen pre-forward boundary in both header formats", () => {
    const headers = new Headers();
    const snapshot = snapshotGatewayPreforwardTiming({
      totalMs: 42.129,
      authMs: 10,
      middleMs: 20.555,
      reserveMs: 5,
      setupMs: 6.5,
    });
    setGatewayPreforwardTelemetryHeaders(headers, "turn_12345678", snapshot);

    expect(snapshot).toEqual({
      totalMs: 42.13,
      authMs: 10,
      middleMs: 20.56,
      reserveMs: 5,
      setupMs: 6.5,
    });
    expect(headers.get("X-Eliza-Preforward-Ms")).toBe(
      "total=42.13;auth=10;mid=20.56;reserve=5;setup=6.5",
    );
    expect(headers.get("Server-Timing")).toContain("gateway_preforward;dur=42.13");
  });

  test("wraps gateway handoffs between capture and emit, including synchronous errors", () => {
    const events: string[] = [];
    const telemetry = {
      capture: () => events.push("capture"),
      emit: () => events.push("emit"),
    };

    expect(
      invokeAtGatewayHandoff(telemetry, () => {
        events.push("handoff");
        return "started";
      }),
    ).toBe("started");
    expect(events).toEqual(["capture", "handoff", "emit"]);

    events.length = 0;
    const failure = new Error("synchronous handoff failure");
    let caught: unknown;
    try {
      invokeAtGatewayHandoff(telemetry, () => {
        events.push("handoff");
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(events).toEqual(["capture", "handoff", "emit"]);

    events.length = 0;
    const monitoredOperation = bindGatewayHandoffTelemetry(telemetry, (input: string) => {
      events.push(`handoff:${input}`);
    });
    const input = (() => {
      events.push("config");
      return "ready";
    })();
    monitoredOperation(input);
    expect(events).toEqual(["config", "capture", "handoff:ready", "emit"]);
  });

  test("re-wraps a gated provider stream without buffering or breaking cancellation", async () => {
    let providerController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelledWith: unknown;
    const providerBody = new ReadableStream<Uint8Array>({
      start(controller) {
        providerController = controller;
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const provider = new Response(providerBody, {
      status: 202,
      statusText: "Accepted",
      headers: {
        "X-Provider-Header": "preserved",
        "Server-Timing": "provider_queue;dur=7",
      },
    });
    const wrapped = withGatewayPreforwardTelemetry(provider, "turn_12345678", {
      totalMs: 12,
      authMs: 3,
      middleMs: 4,
      reserveMs: 2,
      setupMs: 3,
    });

    expect(wrapped.status).toBe(202);
    expect(wrapped.statusText).toBe("Accepted");
    expect(wrapped.body).toBe(provider.body);
    expect(wrapped.headers.get("X-Provider-Header")).toBe("preserved");
    expect(wrapped.headers.get("X-Eliza-Preforward-Ms")).toContain("total=12");
    expect(wrapped.headers.get("Server-Timing")).toContain("provider_queue;dur=7");

    const reader = wrapped.body!.getReader();
    let readSettled = false;
    const firstRead = reader.read().then((value) => {
      readSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(readSettled).toBe(false);

    providerController.enqueue(new TextEncoder().encode("first-provider-chunk"));
    const first = await firstRead;
    expect(new TextDecoder().decode(first.value)).toBe("first-provider-chunk");

    const cancelReason = { reason: "client disconnected" };
    await reader.cancel(cancelReason);
    expect(cancelledWith).toBe(cancelReason);
  });

  test("emits only bounded auth outcomes and correlated sub-hop durations", () => {
    const wrapped = withInferenceAuthTelemetry(
      new Response(null, { status: 400 }),
      "01890f47-6c4a-7b2d-8f31-123456789abc",
      {
        v: 1,
        traceId: "01890f47-6c4a-7b2d-8f31-123456789abc",
        authSource: "x_api_key",
        controlledProbe: "on",
        cacheAvailability: "available",
        cacheBackend: "cloudflare_kv",
        cacheRead: "miss",
        authoritative: "authorized",
        cacheWrite: "written",
        result: "authorized_origin",
        timings: {
          extractMs: 0.1,
          cacheAvailabilityMs: 0.2,
          cacheReadMs: 3,
          keyLookupMs: 40,
          userOrgLookupMs: 30,
          moderationMs: 20,
          cacheWriteMs: 4,
          totalMs: 98,
        },
      },
    );

    expect(wrapped.headers.get(ELIZA_AUTH_TRACE_HEADER)).toBe(
      "v=1;credential=x_api_key;probe=on;available=available;backend=cloudflare_kv;read=miss;authoritative=authorized;write=written;result=authorized_origin",
    );
    const serverTiming = wrapped.headers.get("Server-Timing") ?? "";
    for (const metric of [
      "auth_extract",
      "auth_cache_available",
      "auth_cache_read",
      "auth_key_lookup",
      "auth_user_org",
      "auth_moderation",
      "auth_cache_write",
      "auth_resolve",
    ]) {
      expect(serverTiming).toContain(`${metric};dur=`);
    }
  });

  test("copies every safe compatibility-route telemetry header", () => {
    const from = new Headers({
      "X-Eliza-Trace-Id": "turn_12345678",
      "X-Eliza-Preforward-Ms": "total=12",
      "X-Eliza-Auth-Trace": "v=1;read=hit",
      "X-Eliza-Inference-Path": "passthrough",
      "Server-Timing": "gateway_preforward;dur=12",
      "Timing-Allow-Origin": "https://app.elizacloud.ai",
      Authorization: "Bearer must-not-copy",
    });
    const to = new Headers();

    copyHttpTelemetryHeaders(from, to);

    expect(to.get("X-Eliza-Trace-Id")).toBe("turn_12345678");
    expect(to.get("X-Eliza-Preforward-Ms")).toBe("total=12");
    expect(to.get("X-Eliza-Auth-Trace")).toBe("v=1;read=hit");
    expect(to.get("Server-Timing")).toBe("gateway_preforward;dur=12");
    expect(to.get("Timing-Allow-Origin")).toBe("https://app.elizacloud.ai");
    expect(to.get("X-Eliza-Inference-Path")).toBe("passthrough");
    expect(to.get("Authorization")).toBeNull();
  });
});
