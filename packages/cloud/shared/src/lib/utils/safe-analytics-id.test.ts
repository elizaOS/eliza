/**
 * Coverage for safe-analytics-id.
 */
import { describe, expect, it } from "vitest";
import { safeAnalyticsId } from "./safe-analytics-id.js";

describe("safeAnalyticsId", () => {
  it("accepts valid", () => {
    expect(safeAnalyticsId("abc12345")).toBe("abc12345");
    expect(safeAnalyticsId("a-b_c.d:e1f2g3h4")).toBe("a-b_c.d:e1f2g3h4");
  });
  it("rejects short", () => {
    expect(safeAnalyticsId("short")).toBeNull();
  });
  it("rejects invalid charset", () => {
    expect(safeAnalyticsId("invalid!@#")).toBeNull();
  });
  it("rejects non-string", () => {
    expect(safeAnalyticsId(123 as unknown as string)).toBeNull();
    expect(safeAnalyticsId(null as unknown as string)).toBeNull();
  });
});
