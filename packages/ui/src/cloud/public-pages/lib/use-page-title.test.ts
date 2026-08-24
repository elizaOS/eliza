/**
 * Unit tests for use-page-title: validates hook exports.
 */
import { describe, expect, it } from "vitest";
import { useMetaTag, usePageTitle } from "./use-page-title.ts";

describe("use-page-title", () => {
  it("exports usePageTitle and useMetaTag hook functions", () => {
    expect(typeof usePageTitle).toBe("function");
    expect(typeof useMetaTag).toBe("function");
  });
});
