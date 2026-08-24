/**
 * Unit tests for AdvancedToggle hooks: validates storage keys and listener broadcast.
 */
import { describe, expect, it } from "vitest";
import {
  ADVANCED_TOGGLE_STORAGE_KEY,
  advancedToggleListeners,
  publishAdvancedFlag,
  readPersistedAdvancedFlag,
} from "./AdvancedToggle.hooks.ts";

describe("AdvancedToggle.hooks", () => {
  it("exports ADVANCED_TOGGLE_STORAGE_KEY constant", () => {
    expect(ADVANCED_TOGGLE_STORAGE_KEY).toBe("eliza:settings-advanced");
  });

  it("reads persisted flag safely in non-browser or empty environment", () => {
    const val = readPersistedAdvancedFlag();
    expect(typeof val).toBe("boolean");
  });

  it("broadcasts flag to registered listeners", () => {
    let received: boolean | null = null;
    const listener = (enabled: boolean) => {
      received = enabled;
    };
    advancedToggleListeners.add(listener);
    publishAdvancedFlag(true);
    expect(received).toBe(true);
    advancedToggleListeners.delete(listener);
  });
});
