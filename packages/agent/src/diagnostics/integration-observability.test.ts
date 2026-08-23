/**
 * Unit tests for integration telemetry span creation, timing, error kind inference, and structured logging.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createIntegrationTelemetrySpan,
  type IntegrationObservabilityEvent,
} from "./integration-observability.js";

describe("integration-observability", () => {
  it("records successful integration span with duration and status code", () => {
    let nowTime = 1000;
    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const span = createIntegrationTelemetrySpan(
      {
        boundary: "cloud",
        operation: "fetch_usage",
        timeoutMs: 5000,
      },
      {
        now: () => nowTime,
        sink: loggerMock,
      },
    );

    nowTime = 1250;
    span.success({ statusCode: 200 });

    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    const line = loggerMock.info.mock.calls[0][0] as string;
    expect(line).toContain("[integration]");

    const event: IntegrationObservabilityEvent = JSON.parse(
      line.replace("[integration] ", ""),
    );
    expect(event.boundary).toBe("cloud");
    expect(event.operation).toBe("fetch_usage");
    expect(event.outcome).toBe("success");
    expect(event.durationMs).toBe(250);
    expect(event.timeoutMs).toBe(5000);
    expect(event.statusCode).toBe(200);

    // Second call is ignored (settled)
    span.success({ statusCode: 204 });
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
  });

  it("infers timeout error kind and warns on non-transient failures", () => {
    let nowTime = 2000;
    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const span = createIntegrationTelemetrySpan(
      {
        boundary: "wallet",
        operation: "sign_transaction",
      },
      {
        now: () => nowTime,
        sink: loggerMock,
      },
    );

    nowTime = 2400;
    const timeoutErr = new Error("Request timed out after 5000ms");
    timeoutErr.name = "TimeoutError";

    span.failure({ error: timeoutErr, statusCode: 504 });

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const line = loggerMock.warn.mock.calls[0][0] as string;
    const event: IntegrationObservabilityEvent = JSON.parse(
      line.replace("[integration] ", ""),
    );
    expect(event.boundary).toBe("wallet");
    expect(event.outcome).toBe("failure");
    expect(event.durationMs).toBe(400);
    expect(event.errorKind).toBe("timeout");
  });

  it("emits expected transient failure at info level instead of warn", () => {
    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const span = createIntegrationTelemetrySpan(
      {
        boundary: "lifeops",
        operation: "check_sync",
      },
      {
        sink: loggerMock,
      },
    );

    span.failure({ errorKind: "runtime_unavailable" });

    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
