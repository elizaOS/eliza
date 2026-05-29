import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AvatarModule } from "../types";

function fakeAvatar(id: string): AvatarModule {
  return {
    id,
    title: id,
    kind: "canvas",
    mount: () => ({ unmount: () => undefined }),
  };
}

async function freshRegistry() {
  vi.resetModules();
  return import("../registry");
}

describe("avatar-runtime/registry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("auto-activates the first registered avatar", async () => {
    const { registerAvatar, getActiveAvatar } = await freshRegistry();
    registerAvatar(fakeAvatar("a"));
    expect(getActiveAvatar()?.id).toBe("a");
  });

  it("keeps the first registered avatar active across registrations", async () => {
    const { registerAvatar, getActiveAvatar } = await freshRegistry();
    registerAvatar(fakeAvatar("a"));
    registerAvatar(fakeAvatar("b"));
    expect(getActiveAvatar()?.id).toBe("a");
  });

  it("getAvatar returns a registered module by id", async () => {
    const { registerAvatar, getAvatar } = await freshRegistry();
    registerAvatar(fakeAvatar("a"));
    registerAvatar(fakeAvatar("b"));
    expect(getAvatar("b")?.id).toBe("b");
  });

  it("getAvatar returns undefined for an unknown id", async () => {
    const { registerAvatar, getAvatar } = await freshRegistry();
    registerAvatar(fakeAvatar("a"));
    expect(getAvatar("missing")).toBeUndefined();
  });
});
