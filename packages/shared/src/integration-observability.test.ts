/**
 * Conformance coverage for integration event construction, settle-once behavior
 * and host-injected severity classification.
 */
import { describe, expect, it, vi } from "vitest";
import { createIntegrationTelemetrySpan } from "./integration-observability";

describe("createIntegrationTelemetrySpan", () => {
  it("emits one canonical event across repeated settlement", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const span = createIntegrationTelemetrySpan(
      { boundary: "cloud", operation: "fetch", timeoutMs: 500 },
      {
        now: (() => {
          let value = 10;
          return () => value++;
        })(),
        sink: { info, warn },
      },
    );
    span.success({ statusCode: 204 });
    span.failure({ errorKind: "late_failure" });

    expect(info).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.parse(String(info.mock.calls[0]?.[0]).slice(14))).toEqual({
      schema: "integration_boundary_v1",
      boundary: "cloud",
      operation: "fetch",
      outcome: "success",
      durationMs: 1,
      timeoutMs: 500,
      statusCode: 204,
    });
  });

  it("uses an injected severity policy without changing the event schema", () => {
    const info = vi.fn();
    const warn = vi.fn();
    const span = createIntegrationTelemetrySpan(
      { boundary: "browser-bridge", operation: "connect" },
      {
        now: () => 0,
        sink: { info, warn },
        severityForEvent: () => "info",
      },
    );
    span.failure({ errorKind: "Expected Disconnect" });
    expect(info).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(String(info.mock.calls[0]?.[0])).toContain(
      '"errorKind":"expected_disconnect"',
    );
  });
});
