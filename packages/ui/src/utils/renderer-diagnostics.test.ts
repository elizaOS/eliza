/** Pure diagnostic-envelope coverage; transport logging remains at the boundary. */

import { describe, expect, it } from "vitest";
import { createRendererDiagnostic } from "./renderer-diagnostics";

describe("createRendererDiagnostic", () => {
  it("preserves scope, cause, severity, context, and an explicit correlation ID", () => {
    const cause = new Error("socket closed");
    const error = new Error("could not load", { cause });
    expect(
      createRendererDiagnostic({
        scope: "catalog.load",
        error,
        severity: "warning",
        context: { viewId: "calendar" },
        correlationId: "diag-1",
      }),
    ).toEqual({
      scope: "catalog.load",
      message: "could not load",
      severity: "warning",
      correlationId: "diag-1",
      cause,
      context: { viewId: "calendar" },
    });
  });

  it("assigns unique correlation IDs when callers do not provide one", () => {
    const first = createRendererDiagnostic({ scope: "one", error: "failed" });
    const second = createRendererDiagnostic({ scope: "two", error: "failed" });
    expect(first.correlationId).not.toBe(second.correlationId);
  });
});
