import { describe, expect, it } from "vitest";
import {
  getPerfSnapshot,
  isPerfInstrumentEnabled,
  normalizeRouteKey,
} from "./perf-instrument.ts";

describe("normalizeRouteKey", () => {
  it("combines method and collapsed pathname", () => {
    expect(normalizeRouteKey("GET", "/api/users/123")).toBe("GET /api/users/:n");
  });

  it("collapses numeric segments only", () => {
    const key = normalizeRouteKey("POST", "/v1/accounts/abc123/orders/999");
    expect(key).toBe("POST /v1/accounts/abc123/orders/:n");
  });

  it("preserves the method verb", () => {
    expect(normalizeRouteKey("DELETE", "/x/1")).toContain("DELETE");
  });

  it("leaves non-numeric paths unchanged", () => {
    expect(normalizeRouteKey("GET", "/api/health")).toBe("GET /api/health");
  });
});

describe("perf snapshot", () => {
  it("reflects the load-time enabled flag", () => {
    const snapshot = getPerfSnapshot();
    expect(snapshot.enabled).toBe(isPerfInstrumentEnabled());
  });

  it("returns empty route/cache collections", () => {
    const snapshot = getPerfSnapshot();
    expect(Array.isArray(snapshot.routes)).toBe(true);
    expect(Array.isArray(snapshot.caches)).toBe(true);
  });
});
