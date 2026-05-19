import { beforeEach, describe, expect, it } from "vitest";
import {
  getActiveBackground,
  getBackgroundHistory,
  listBackgrounds,
  registerBackground,
  resetBackgroundRegistry,
  revertBackground,
  setActiveBackground,
} from "../registry";
import { createSlowCloudsBackground } from "../slow-clouds";
import type { BackgroundModule } from "../types";

function fakeModule(id: string): BackgroundModule {
  return {
    id,
    kind: "solid",
    fpsBudget: 1,
    mount: () => ({ update: () => undefined, unmount: () => undefined }),
  };
}

describe("backgrounds/registry", () => {
  beforeEach(() => {
    resetBackgroundRegistry();
  });

  it("auto-selects the first registered module as active", () => {
    const mod = createSlowCloudsBackground();
    registerBackground(mod);
    expect(getActiveBackground()?.id).toBe(mod.id);
  });

  it("lists all registered modules", () => {
    registerBackground(fakeModule("a"));
    registerBackground(fakeModule("b"));
    expect(listBackgrounds().map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("setActiveBackground switches the active id", () => {
    registerBackground(fakeModule("a"));
    registerBackground(fakeModule("b"));
    const result = setActiveBackground("b");
    expect(result?.id).toBe("b");
    expect(getActiveBackground()?.id).toBe("b");
  });

  it("setActiveBackground returns undefined for unknown id", () => {
    registerBackground(fakeModule("a"));
    expect(setActiveBackground("missing")).toBeUndefined();
    expect(getActiveBackground()?.id).toBe("a");
  });

  it("keeps at most three entries in history", () => {
    registerBackground(fakeModule("a"));
    registerBackground(fakeModule("b"));
    registerBackground(fakeModule("c"));
    registerBackground(fakeModule("d"));
    const ids = getBackgroundHistory().map((m) => m.id);
    expect(ids).toEqual(["b", "c", "d"]);
  });

  it("revertBackground moves active to the previous history entry", () => {
    registerBackground(fakeModule("a"));
    registerBackground(fakeModule("b"));
    setActiveBackground("b");
    const reverted = revertBackground();
    expect(reverted?.id).toBe("a");
    expect(getActiveBackground()?.id).toBe("a");
  });

  it("revertBackground is a no-op when history is empty", () => {
    expect(revertBackground()).toBeUndefined();
  });
});
