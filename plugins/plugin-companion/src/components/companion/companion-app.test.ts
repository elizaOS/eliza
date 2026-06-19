import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

import {
  COMPANION_APP_NAME,
  companionApp,
  registerCompanionApp,
} from "./companion-app";

describe("companion overlay registration", () => {
  it("describes the companion overlay app", () => {
    expect(companionApp).toMatchObject({
      name: COMPANION_APP_NAME,
      displayName: "Eliza Companion",
      description: "3D companion with VRM avatar and chat",
      category: "game",
    });
    expect(companionApp.loader).toEqual(expect.any(Function));
  });

  it("registers the exported overlay descriptor", () => {
    registerCompanionApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(companionApp);
  });
});
