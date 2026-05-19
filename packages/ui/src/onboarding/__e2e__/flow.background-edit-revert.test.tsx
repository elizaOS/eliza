import { beforeEach, describe, expect, it } from "vitest";
import {
  getActiveBackground,
  registerBackground,
  resetBackgroundRegistry,
  revertBackground,
  setActiveBackground,
} from "../../backgrounds/registry";
import type { BackgroundModule } from "../../backgrounds/types";

function fakeBackground(id: string): BackgroundModule {
  return {
    id,
    kind: "solid",
    fpsBudget: 1,
    mount: () => ({ update: () => undefined, unmount: () => undefined }),
  };
}

beforeEach(() => {
  resetBackgroundRegistry();
});

describe("BACKGROUND_EDIT revert contract", () => {
  it("registerBackground + setActiveBackground(new) + revert returns the previous active id", () => {
    const original = fakeBackground("og-bg");
    registerBackground(original);
    expect(getActiveBackground()?.id).toBe("og-bg");

    const replacement = fakeBackground("new-bg");
    registerBackground(replacement);
    setActiveBackground("new-bg");
    expect(getActiveBackground()?.id).toBe("new-bg");

    const reverted = revertBackground();
    expect(reverted?.id).toBe("og-bg");
    expect(getActiveBackground()?.id).toBe("og-bg");
  });

  it("revert is a no-op when history holds fewer than two entries", () => {
    registerBackground(fakeBackground("only"));
    expect(revertBackground()).toBeUndefined();
    expect(getActiveBackground()?.id).toBe("only");
  });

  it("revert always targets the second-newest entry in registration history", () => {
    registerBackground(fakeBackground("a"));
    registerBackground(fakeBackground("b"));
    registerBackground(fakeBackground("c"));
    setActiveBackground("c");
    const reverted = revertBackground();
    expect(reverted?.id).toBe("b");
    expect(getActiveBackground()?.id).toBe("b");
  });
});
