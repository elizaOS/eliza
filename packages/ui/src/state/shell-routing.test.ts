import { describe, expect, it } from "vitest";
import {
  deriveUiShellModeForTab,
  getTabForShellView,
} from "./shell-routing.js";

describe("shell-routing", () => {
  it("always returns native for derive", () => {
    expect(deriveUiShellModeForTab("chat" as never)).toBe("native");
    expect(deriveUiShellModeForTab("character" as never)).toBe("native");
  });

  it("returns character for character view", () => {
    expect(getTabForShellView("character" as never, "chat" as never)).toBe(
      "character",
    );
  });

  it("guards character-select", () => {
    expect(
      getTabForShellView("chat" as never, "character-select" as never),
    ).toBe("chat");
  });

  it("returns last tab otherwise", () => {
    expect(getTabForShellView("chat" as never, "chat" as never)).toBe("chat");
    expect(getTabForShellView("chat" as never, "explore" as never)).toBe(
      "explore",
    );
  });
});
