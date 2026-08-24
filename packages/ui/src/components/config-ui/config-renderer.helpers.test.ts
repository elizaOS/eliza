/**
 * Unit tests for config renderer helpers: validates defaultRegistry definitions.
 */
import { describe, expect, it } from "vitest";
import { defaultRegistry } from "./config-renderer.helpers.ts";

describe("config-renderer.helpers", () => {
  it("exports defaultRegistry mapping catalog to renderers", () => {
    expect(defaultRegistry).toBeDefined();
    expect(typeof defaultRegistry).toBe("object");
  });
});
