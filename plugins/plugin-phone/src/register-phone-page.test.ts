/**
 * Registration coverage for the bundled native Phone route. The test inspects
 * the app-shell contract without loading a remote view bundle.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const registration = vi.hoisted(() => ({
  register: vi.fn(),
}));
const platform = vi.hoisted(() => ({ current: "android" }));

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage: registration.register,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform.current },
}));

describe("native Phone page registration", () => {
  beforeEach(() => {
    registration.register.mockClear();
    platform.current = "android";
    vi.resetModules();
  });

  it("registers /phone with a bundled PhoneView loader", async () => {
    await import("./register-phone-page");

    expect(registration.register).toHaveBeenCalledOnce();
    expect(registration.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "phone",
        pluginId: "@elizaos/plugin-phone",
        path: "/phone",
        tabAffinity: "phone",
        loader: expect.any(Function),
      }),
    );
  });

  it("does not expose native call controls on web hosts", async () => {
    platform.current = "web";
    await import("./register-phone-page");
    expect(registration.register).not.toHaveBeenCalled();
  });
});
