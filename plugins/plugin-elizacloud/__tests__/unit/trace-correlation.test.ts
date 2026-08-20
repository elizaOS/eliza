/**
 * Covers the turn-to-gateway trace correlation helpers (#16079): outbound
 * trace-header attachment, strict parsing of the gateway's echoed
 * `X-Eliza-Preforward-Ms` decomposition, and folding echoed telemetry back
 * into the real inference-timing turn. Deterministic; uses the real
 * `@elizaos/core` InferenceTurnTimer and real `Response` objects — no mocks.
 */
import { InferenceTurnTimer, runWithInferenceTiming } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  ELIZA_PREFORWARD_HEADER,
  ELIZA_TRACE_ID_HEADER,
  parseGatewayPreforwardHeader,
  recordGatewayResponseTelemetry,
  withInferenceTraceHeader,
} from "../../src/utils/trace-correlation";

const timer = () => new InferenceTurnTimer({ turnId: "t", label: "test" });

function gatewayResponse(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

describe("withInferenceTraceHeader", () => {
  it("attaches the active turn's trace id and preserves existing headers", () => {
    const t = timer();
    runWithInferenceTiming(t, () => {
      const headers = withInferenceTraceHeader({ "X-Eliza-Model-Type": "TEXT_LARGE" });
      expect(headers[ELIZA_TRACE_ID_HEADER]).toBe(t.traceId);
      expect(headers["X-Eliza-Model-Type"]).toBe("TEXT_LARGE");
    });
  });

  it("leaves headers untouched outside a timed turn", () => {
    const headers = withInferenceTraceHeader({ "X-Eliza-Model-Type": "TEXT_LARGE" });
    expect(ELIZA_TRACE_ID_HEADER in headers).toBe(false);
  });
});

describe("parseGatewayPreforwardHeader", () => {
  it("parses the gateway's frozen five-field decomposition", () => {
    expect(parseGatewayPreforwardHeader("total=142.5;auth=4;mid=0;reserve=3;setup=135.5")).toEqual({
      totalMs: 142.5,
      authMs: 4,
      midMs: 0,
      reserveMs: 3,
      setupMs: 135.5,
    });
  });

  it.each([
    [null, "absent header"],
    ["", "empty value"],
    ["total=1;auth=2;mid=3;reserve=4", "missing field"],
    ["total=1;auth=2;mid=3;reserve=4;setup=5;setup=6", "duplicate field"],
    ["total=1;auth=2;mid=3;reserve=4;setup=-1", "negative duration"],
    ["total=1;auth=2;mid=3;reserve=4;setup=NaN", "non-finite duration"],
    ["total=9999999999;auth=2;mid=3;reserve=4;setup=5", "absurd duration"],
    ["total=1;auth=2;mid=3;reserve=4;bogus=5", "unknown field"],
    [`total=1;auth=2;mid=3;reserve=4;setup=${"5".repeat(300)}`, "oversized value"],
  ])("rejects %s (%s) as a whole", (value) => {
    expect(parseGatewayPreforwardHeader(value)).toBeNull();
  });
});

describe("recordGatewayResponseTelemetry", () => {
  it("records a correlated gateway span when the gateway echoes the turn's id", () => {
    const t = timer();
    runWithInferenceTiming(t, () => {
      recordGatewayResponseTelemetry(
        gatewayResponse({
          [ELIZA_TRACE_ID_HEADER]: t.traceId,
          [ELIZA_PREFORWARD_HEADER]: "total=142;auth=4;mid=54;reserve=3;setup=81",
        }),
        "chat/completions"
      );
    });
    const s = t.close();
    const span = s.spans.find((entry) => entry.name === "cloud.gateway-preforward");
    expect(span).toBeDefined();
    expect(span?.durationMs).toBe(142);
    expect(span?.meta).toMatchObject({
      route: "chat/completions",
      authMs: 4,
      midMs: 54,
      reserveMs: 3,
      setupMs: 81,
      correlated: true,
      gatewayTraceId: t.traceId,
    });
  });

  it("marks an uncorrelated span when the gateway minted its own id", () => {
    const t = timer();
    runWithInferenceTiming(t, () => {
      recordGatewayResponseTelemetry(
        gatewayResponse({
          [ELIZA_TRACE_ID_HEADER]: "123e4567-e89b-42d3-a456-426614174000",
          [ELIZA_PREFORWARD_HEADER]: "total=10;auth=1;mid=2;reserve=3;setup=4",
        }),
        "responses"
      );
    });
    const span = t.close().spans.find((entry) => entry.name === "cloud.gateway-preforward");
    expect(span?.meta).toMatchObject({
      correlated: false,
      gatewayTraceId: "123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("drops an invalid echoed id but keeps the timing decomposition", () => {
    const t = timer();
    runWithInferenceTiming(t, () => {
      recordGatewayResponseTelemetry(
        gatewayResponse({
          [ELIZA_TRACE_ID_HEADER]: "<script>alert(1)</script>",
          [ELIZA_PREFORWARD_HEADER]: "total=10;auth=1;mid=2;reserve=3;setup=4",
        }),
        "responses"
      );
    });
    const span = t.close().spans.find((entry) => entry.name === "cloud.gateway-preforward");
    expect(span?.durationMs).toBe(10);
    expect(span?.meta?.correlated).toBe(false);
    expect(span?.meta && "gatewayTraceId" in span.meta).toBe(false);
  });

  it("records nothing when the preforward header is missing or invalid", () => {
    const t = timer();
    runWithInferenceTiming(t, () => {
      recordGatewayResponseTelemetry(gatewayResponse({}), "chat/completions");
      recordGatewayResponseTelemetry(
        gatewayResponse({ [ELIZA_PREFORWARD_HEADER]: "total=1;auth=broken" }),
        "chat/completions"
      );
    });
    expect(t.close().spans.some((entry) => entry.name === "cloud.gateway-preforward")).toBe(false);
  });

  it("is a no-op outside a timed turn", () => {
    expect(() =>
      recordGatewayResponseTelemetry(
        gatewayResponse({ [ELIZA_PREFORWARD_HEADER]: "total=1;auth=1;mid=1;reserve=1;setup=1" }),
        "chat/completions"
      )
    ).not.toThrow();
  });
});
