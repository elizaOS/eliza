/**
 * Unit tests for DesktopWorkspaceDisplay hooks: validates diagnostics text hook export.
 */
import { describe, expect, it } from "vitest";
import { useDesktopDiagnosticsText } from "./DesktopWorkspaceDisplay.hooks.ts";

describe("DesktopWorkspaceDisplay.hooks", () => {
  it("exports useDesktopDiagnosticsText hook function", () => {
    expect(typeof useDesktopDiagnosticsText).toBe("function");
  });
});
