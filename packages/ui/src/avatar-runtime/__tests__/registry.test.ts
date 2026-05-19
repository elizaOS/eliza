import { beforeEach, describe, expect, it } from "vitest";
import {
  getActiveAvatar,
  getAvatarHistory,
  listAvatars,
  registerAvatar,
  resetAvatarRegistry,
  revertAvatar,
  setActiveAvatar,
} from "../registry";
import type { AvatarModule } from "../types";

function fakeAvatar(id: string): AvatarModule {
  return {
    id,
    title: id,
    kind: "canvas",
    mount: () => ({ unmount: () => undefined }),
  };
}

describe("avatar-runtime/registry", () => {
  beforeEach(() => {
    resetAvatarRegistry();
  });

  it("auto-activates the first registered avatar", () => {
    registerAvatar(fakeAvatar("a"));
    expect(getActiveAvatar()?.id).toBe("a");
  });

  it("setActiveAvatar switches the active module", () => {
    registerAvatar(fakeAvatar("a"));
    registerAvatar(fakeAvatar("b"));
    setActiveAvatar("b");
    expect(getActiveAvatar()?.id).toBe("b");
  });

  it("setActiveAvatar returns undefined for unknown id", () => {
    registerAvatar(fakeAvatar("a"));
    expect(setActiveAvatar("missing")).toBeUndefined();
    expect(getActiveAvatar()?.id).toBe("a");
  });

  it("listAvatars returns all registered modules", () => {
    registerAvatar(fakeAvatar("a"));
    registerAvatar(fakeAvatar("b"));
    expect(listAvatars().map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("keeps at most three history entries", () => {
    registerAvatar(fakeAvatar("a"));
    registerAvatar(fakeAvatar("b"));
    registerAvatar(fakeAvatar("c"));
    registerAvatar(fakeAvatar("d"));
    expect(getAvatarHistory().map((m) => m.id)).toEqual(["b", "c", "d"]);
  });

  it("revertAvatar moves to the previous history entry", () => {
    registerAvatar(fakeAvatar("a"));
    registerAvatar(fakeAvatar("b"));
    setActiveAvatar("b");
    const reverted = revertAvatar();
    expect(reverted?.id).toBe("a");
    expect(getActiveAvatar()?.id).toBe("a");
  });
});
