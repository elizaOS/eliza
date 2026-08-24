/**
 * Unit tests for ConnectorModeSelector helpers: validates mode resolution and default selection.
 */
import { describe, expect, it } from "vitest";
import {
  type ConnectorMode,
  getConnectorModes,
  getDefaultConnectorModeId,
  modeToSetupPluginId,
} from "./ConnectorModeSelector.helpers.ts";

describe("ConnectorModeSelector.helpers", () => {
  it("resolves available connector modes for given connector ID", () => {
    const modes = getConnectorModes("telegram");
    expect(Array.isArray(modes)).toBe(true);
  });

  it("selects default connector mode from list", () => {
    const modes: ConnectorMode[] = [
      { id: "mode-a", label: "Mode A", description: "First" },
      { id: "mode-b", label: "Mode B", description: "Second" },
    ];
    const def = getDefaultConnectorModeId("test-connector", modes);
    expect(def).toBe("mode-a");
  });

  it("returns null setup plugin ID for unknown mode", () => {
    expect(modeToSetupPluginId("unknown", "unknown")).toBeNull();
  });
});
