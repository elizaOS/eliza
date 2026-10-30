import { Capacitor } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCameraPlugin, type MobileSignalsPluginLike, type TalkModePluginLike } from "../../bridge/native-plugins";
import { supportedNativePrimingPermissions } from "../../components/permissions/native-permission-host";
import { createMobileSignalsPermissionsRegistry } from "../mobile-permissions-client";

vi.mock("../init", () => ({ platform: "android" }));
vi.mock("../../state/notifications/push-registration", () => ({ initPushRegistration: vi.fn() }));

const plugins = Capacitor as typeof Capacitor & { Plugins?: Record<string, unknown> };
const original = plugins.Plugins;
const headers = Capacitor as typeof Capacitor & { PluginHeaders?: unknown };
const originalHeaders = headers.PluginHeaders;
afterEach(() => {
  plugins.Plugins = original;
  headers.PluginHeaders = originalHeaders;
  vi.restoreAllMocks();
});
const options = { reason: "Camera", feature: { app: "onboarding", action: "permission-priming" } };

describe("scoped native camera permission", () => {
  it("uses the installed canonical bridge ahead of legacy names", () => {
    const canonical = { checkCameraPermission: vi.fn(), requestCameraPermission: vi.fn() };
    plugins.Plugins = { ElizaCamera: canonical, AppCamera: {}, Camera: {} };
    expect(getCameraPlugin()).toBe(canonical);
    expect(supportedNativePrimingPermissions()).toContain("camera");
    plugins.Plugins = { AppCamera: { checkPermissions: vi.fn(), requestPermissions: vi.fn() } };
    expect(supportedNativePrimingPermissions()).not.toContain("camera");
  });

  it("does not admit methods fabricated by an older native proxy", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    plugins.Plugins = { ElizaCamera: new Proxy({}, { get: () => vi.fn() }) };
    headers.PluginHeaders = [{ name: "ElizaCamera", methods: [{ name: "requestPermissions" }] }];
    expect(supportedNativePrimingPermissions()).not.toContain("camera");
    headers.PluginHeaders = [{ name: "ElizaCamera", methods: [
      { name: "checkCameraPermission" }, { name: "requestCameraPermission" },
    ] }];
    expect(supportedNativePrimingPermissions()).toContain("camera");
  });

  it("requests only the scoped camera method and reads its actual result", async () => {
    let state: "prompt" | "granted" = "prompt";
    const broad = vi.fn(() => { throw Error("Broad permission request"); });
    const requestCameraPermission = vi.fn(async () => { state = "granted"; return { camera: state }; });
    const registry = createMobileSignalsPermissionsRegistry({} as MobileSignalsPluginLike, undefined, {}, {}, {
      camera: { checkCameraPermission: async () => ({ camera: state }), requestCameraPermission, requestPermissions: broad },
    });
    expect((await registry.check("camera")).status).toBe("not-determined");
    expect((await registry.request("camera", options)).status).toBe("granted");
    expect(requestCameraPermission).toHaveBeenCalledOnce();
    expect(broad).not.toHaveBeenCalled();
  });

  it("never uses the legacy all-permission request for camera, microphone or photos", async () => {
    const broad = vi.fn(() => { throw Error("Broad permission request"); });
    const health = vi.fn(() => { throw Error("Wrong permission target"); });
    const registry = createMobileSignalsPermissionsRegistry({ requestPermissions: health } as unknown as MobileSignalsPluginLike, undefined, {}, {}, {
      camera: { checkPermissions: async () => ({ camera: "prompt", microphone: "prompt", photos: "granted" }), requestPermissions: broad },
      talkMode: {} as TalkModePluginLike,
    });
    for (const id of ["camera", "microphone", "photos"] as const) {
      expect((await registry.check(id)).status).toBe("not-applicable");
      expect((await registry.request(id, options)).status).toBe("not-applicable");
    }
    expect(broad).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
  });
});
