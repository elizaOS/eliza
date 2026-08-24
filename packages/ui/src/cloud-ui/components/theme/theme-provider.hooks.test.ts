/**
 * Unit tests for theme provider hooks: validates context and hook definitions.
 */
import { describe, expect, it } from "vitest";
import { ThemeContext, useTheme } from "./theme-provider.hooks.ts";

describe("theme-provider.hooks", () => {
  it("exports ThemeContext and useTheme hook function", () => {
    expect(ThemeContext).toBeDefined();
    expect(typeof useTheme).toBe("function");
  });
});
