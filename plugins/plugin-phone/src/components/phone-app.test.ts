import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

import { PHONE_APP_NAME, phoneApp, registerPhoneApp } from "./phone-app";

describe("phone overlay registration", () => {
  it("describes an Android-only phone overlay app", () => {
    expect(phoneApp).toMatchObject({
      name: PHONE_APP_NAME,
      displayName: "Phone",
      description: "Dialer, recent calls, and contact calling for Android",
      category: "system",
      androidOnly: true,
    });
    expect(phoneApp.loader).toEqual(expect.any(Function));
  });

  it("registers the exported overlay descriptor", () => {
    registerPhoneApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(phoneApp);
  });
});
