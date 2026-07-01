/**
 * Unit coverage for `httpErrorDiagnosticLevel`, the single source of truth for
 * how the renderer fetch/XHR diagnostic mirror classifies an HTTP status.
 *
 * Boot-probe 404 suppression was retired alongside the plugins that emitted
 * those probes (see chore: purge deleted-plugin refs), so the policy is now a
 * pure status-class mapping: `5xx` -> `"error"`, everything else the caller
 * already deemed a failure -> `"warn"`.
 *
 *   cd packages/app-core/platforms/electrobun && bun test src/diagnostic-format.test.ts
 */

import { describe, expect, it } from "vitest";
import { httpErrorDiagnosticLevel } from "./diagnostic-format";

describe("httpErrorDiagnosticLevel", () => {
  it("reports 5xx as 'error'", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(httpErrorDiagnosticLevel(status)).toBe("error");
    }
  });

  it("reports 4xx as 'warn'", () => {
    for (const status of [400, 401, 403, 404, 405, 409, 410, 418, 422, 429]) {
      expect(httpErrorDiagnosticLevel(status)).toBe("warn");
    }
  });

  it("treats 3xx (e.g. an unfollowed redirect surfaced via fetch !response.ok) as 'warn'", () => {
    // The fetch wrapper only consults this helper when !response.ok, so a 3xx
    // that reaches it is a real anomaly worth surfacing — not suppressed.
    expect(httpErrorDiagnosticLevel(302)).toBe("warn");
  });
});
