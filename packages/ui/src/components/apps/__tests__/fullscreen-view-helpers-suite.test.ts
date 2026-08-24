/**
 * Unit tests for fullscreen game view click audit manifest.
 * Validates desktop click targets, entry points, and coverage declarations.
 */
import { describe, expect, it } from "vitest";
import { DESKTOP_GAME_CLICK_AUDIT } from "../FullscreenView.helpers.ts";

describe("FullscreenView.helpers", () => {
  it("defines required desktop click audit items", () => {
    expect(DESKTOP_GAME_CLICK_AUDIT).toHaveLength(6);

    const ids = DESKTOP_GAME_CLICK_AUDIT.map((item) => item.id);
    expect(ids).toContain("game-native-refresh");
    expect(ids).toContain("game-native-focus");
    expect(ids).toContain("game-native-visibility");
    expect(ids).toContain("game-native-always-on-top");
    expect(ids).toContain("game-native-snapshot");
    expect(ids).toContain("game-gpu-window");
  });

  it("ensures each audit item specifies desktop requirement and game entrypoint", () => {
    for (const item of DESKTOP_GAME_CLICK_AUDIT) {
      expect(item.entryPoint).toBe("game");
      expect(item.runtimeRequirement).toBe("desktop");
      expect(item.coverage).toBe("automated");
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.expectedAction.length).toBeGreaterThan(0);
    }
  });
});
