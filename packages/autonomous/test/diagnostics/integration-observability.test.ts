import { describe, test, expect, vi } from "vitest";
import { createIntegrationTelemetrySpan } from "../../src/diagnostics/integration-observability";

function buildSink() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("createIntegrationTelemetrySpan", () => {
  test("success() does not throw and emits via sink.info", () => {
    const sink = buildSink();
    const span = createIntegrationTelemetrySpan(
      { boundary: "cloud", operation: "fetch-config" },
      { sink, now: () => 1000 },
    );

    expect(() => span.success()).not.toThrow();
    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.warn).not.toHaveBeenCalled();

    const logged = sink.info.mock.calls[0][0] as string;
    expect(logged).toContain("[integration]");
    const event = JSON.parse(logged.replace("[integration] ", ""));
    expect(event.schema).toBe("integration_boundary_v1");
    expect(event.boundary).toBe("cloud");
    expect(event.operation).toBe("fetch-config");
    expect(event.outcome).toBe("success");
  });

  test("failure() does not throw and emits via sink.warn", () => {
    const sink = buildSink();
    const span = createIntegrationTelemetrySpan(
      { boundary: "wallet", operation: "sign-tx" },
      { sink, now: () => 2000 },
    );

    expect(() => span.failure({ error: new Error("timeout") })).not.toThrow();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.info).not.toHaveBeenCalled();

    const logged = sink.warn.mock.calls[0][0] as string;
    const event = JSON.parse(logged.replace("[integration] ", ""));
    expect(event.outcome).toBe("failure");
    expect(event.errorKind).toBeDefined();
  });

  test("success() with statusCode includes it in the event", () => {
    const sink = buildSink();
    const span = createIntegrationTelemetrySpan(
      { boundary: "marketplace", operation: "list-plugins" },
      { sink, now: () => 0 },
    );

    span.success({ statusCode: 200 });

    const logged = sink.info.mock.calls[0][0] as string;
    const event = JSON.parse(logged.replace("[integration] ", ""));
    expect(event.statusCode).toBe(200);
  });

  test("double-call protection: second call is silently ignored", () => {
    const sink = buildSink();
    const span = createIntegrationTelemetrySpan(
      { boundary: "cloud", operation: "test-double" },
      { sink, now: () => 500 },
    );

    span.success();
    span.failure();
    span.success();

    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.warn).not.toHaveBeenCalled();
  });

  test("failure after success is ignored", () => {
    const sink = buildSink();
    const span = createIntegrationTelemetrySpan(
      { boundary: "mcp", operation: "connect" },
      { sink, now: () => 100 },
    );

    span.success();
    span.failure({ error: new Error("late error") });

    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.warn).not.toHaveBeenCalled();
  });

  test("success after failure is ignored", () => {
    const sink = buildSink();
    const span = createIntegrationTelemetrySpan(
      { boundary: "mcp", operation: "connect" },
      { sink, now: () => 100 },
    );

    span.failure();
    span.success();

    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.info).not.toHaveBeenCalled();
  });

  test("duration is computed from now function", () => {
    const sink = buildSink();
    let time = 1000;
    const span = createIntegrationTelemetrySpan(
      { boundary: "cloud", operation: "timed-op" },
      { sink, now: () => time },
    );

    time = 1250;
    span.success();

    const logged = sink.info.mock.calls[0][0] as string;
    const event = JSON.parse(logged.replace("[integration] ", ""));
    expect(event.durationMs).toBe(250);
  });

  test("timeoutMs is included when specified in meta", () => {
    const sink = buildSink();
    const span = createIntegrationTelemetrySpan(
      { boundary: "cloud", operation: "slow-call", timeoutMs: 5000 },
      { sink, now: () => 0 },
    );

    span.success();

    const logged = sink.info.mock.calls[0][0] as string;
    const event = JSON.parse(logged.replace("[integration] ", ""));
    expect(event.timeoutMs).toBe(5000);
  });
});
