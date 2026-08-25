/**
 * Deterministic unit coverage for integration-boundary telemetry emission and
 * adversarial token normalization. The logger and clock are injected; no live
 * integration or network service is used.
 */

import { describe, expect, it, vi } from "vitest";
import { createIntegrationTelemetrySpan } from "./integration-observability";

describe("createIntegrationTelemetrySpan", () => {
  it("collapses and trims 100k invalid token separators in linear time", () => {
    const warn = vi.fn();
    const span = createIntegrationTelemetrySpan(
      { boundary: "cloud", operation: "request" },
      { now: () => 10, sink: { info: vi.fn(), warn } },
    );

    span.failure({
      errorKind: `${"_".repeat(100_000)}Provider${"_".repeat(100_000)}Failure${"_".repeat(100_000)}`,
    });

    expect(warn).toHaveBeenCalledOnce();
    const event = JSON.parse(
      String(warn.mock.calls[0]?.[0]).slice("[integration] ".length),
    );
    expect(event.errorKind).toBe("provider_failure");
  });
});
