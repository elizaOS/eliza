/**
 * Unit tests for console surfaces: validates advertised nav and surface definitions.
 */
import { describe, expect, it } from "vitest";
import {
  CONSOLE_OVERVIEW_NAV_ITEM,
  CONSOLE_SURFACES,
} from "./console-surfaces.ts";

describe("console-surfaces", () => {
  it("defines overview nav item with expected href", () => {
    expect(CONSOLE_OVERVIEW_NAV_ITEM.id).toBe("overview");
    expect(CONSOLE_OVERVIEW_NAV_ITEM.href).toBe("/cloud");
    expect(CONSOLE_OVERVIEW_NAV_ITEM.label).toBe("Overview");
  });

  it("defines core console surfaces with labels and route paths", () => {
    expect(CONSOLE_SURFACES.length).toBeGreaterThanOrEqual(4);
    const ids = CONSOLE_SURFACES.map((s) => s.id);
    expect(ids).toContain("agents");
    expect(ids).toContain("billing");
    expect(ids).toContain("api-keys");
    expect(ids).toContain("account");

    for (const surface of CONSOLE_SURFACES) {
      expect(surface.href.startsWith("/cloud/")).toBe(true);
      expect(typeof surface.label).toBe("string");
      expect(typeof surface.titleDefault).toBe("string");
    }
  });
});
