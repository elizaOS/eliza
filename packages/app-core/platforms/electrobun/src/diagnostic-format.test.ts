/**
 * Unit coverage for `httpErrorDiagnosticLevel`, the single source of truth for
 * how the renderer fetch/XHR diagnostic mirror classifies an HTTP status.
 *
 * The behaviour we must guarantee for PR #8043:
 *  - known optional boot-probe `404`s are suppressed — e.g. probing
 *    `/api/vincent/status` during the boot window must NOT warn.
 *  - Genuine failures are NOT suppressed: `5xx` -> `"error"`, every other 4xx
 *    (`401`/`403`/`404`/`410`/`429`) -> `"warn"`.
 *
 *   cd eliza/packages/app-core/platforms/electrobun && bun test src/diagnostic-format.test.ts
 */

import { describe, expect, it } from "vitest";
import { httpErrorDiagnosticLevel } from "./diagnostic-format";

describe("httpErrorDiagnosticLevel", () => {
  it("suppresses 404 for known optional boot probes", () => {
    expect(
      httpErrorDiagnosticLevel(404, {
        url: "http://localhost:3000/api/vincent/status",
        method: "GET",
      }),
    ).toBeNull();
    expect(
      httpErrorDiagnosticLevel(404, {
        url: "/api/vincent/status?probe=1",
        method: "HEAD",
      }),
    ).toBeNull();
  });

  it("reports unrelated 404s as 'warn'", () => {
    expect(
      httpErrorDiagnosticLevel(404, {
        url: "/api/vincent/sttaus",
        method: "GET",
      }),
    ).toBe("warn");
    expect(
      httpErrorDiagnosticLevel(404, {
        url: "/assets/missing.js",
        method: "GET",
      }),
    ).toBe("warn");
    expect(
      httpErrorDiagnosticLevel(404, {
        url: "/api/vincent/status",
        method: "POST",
      }),
    ).toBe("warn");
  });

  it("reports 5xx as 'error'", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(httpErrorDiagnosticLevel(status)).toBe("error");
    }
  });

  it("reports other 4xx as 'warn'", () => {
    for (const status of [400, 401, 403, 405, 409, 410, 418, 422, 429]) {
      expect(httpErrorDiagnosticLevel(status)).toBe("warn");
    }
  });

  it("treats 3xx (e.g. an unfollowed redirect surfaced via fetch !response.ok) as 'warn'", () => {
    // The fetch wrapper only consults this helper when !response.ok, so a 3xx
    // that reaches it is a real anomaly worth surfacing — not suppressed.
    expect(httpErrorDiagnosticLevel(302)).toBe("warn");
  });
});
