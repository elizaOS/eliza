import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
} from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CameraPluginLike,
  LocationPluginLike,
  ScreenCapturePluginLike,
} from "../bridge/native-plugins";
import {
  getFriendlyNameFromUserId,
  type ProactiveIosPermissionsProgress,
  requestProactiveIosPermissions,
} from "./proactive-ios-permissions";

const capacitorState = vi.hoisted(() => ({
  isNative: true,
  platform: "ios",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: vi.fn(() => capacitorState.platform),
    isNativePlatform: vi.fn(() => capacitorState.isNative),
  },
}));

function permissionState(
  id: PermissionId,
  status: PermissionState["status"] = "granted",
  canRequest = false,
): PermissionState {
  return {
    id,
    status,
    lastChecked: Date.now(),
    canRequest,
    platform: "ios",
  };
}

function registry(): IPermissionsRegistry {
  const states = new Map<PermissionId, PermissionState>();
  const registryImpl: IPermissionsRegistry = {
    get: vi.fn(
      (id) => states.get(id) ?? permissionState(id, "not-determined", true),
    ),
    check: vi.fn(
      async (id) =>
        states.get(id) ?? permissionState(id, "not-determined", true),
    ),
    request: vi.fn(async (id) => {
      const next = permissionState(id);
      states.set(id, next);
      return next;
    }),
    recordBlock: vi.fn(),
    list: vi.fn(() => Array.from(states.values())),
    pending: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    registerProber: vi.fn(),
  };
  return registryImpl;
}

describe("requestProactiveIosPermissions", () => {
  beforeEach(() => {
    capacitorState.isNative = true;
    capacitorState.platform = "ios";
  });

  it("requests the proactive iOS startup permissions", async () => {
    const permissionsRegistry = registry();
    const cameraPlugin: CameraPluginLike = {
      requestPermissions: vi.fn(
        async () =>
          ({
            camera: "granted",
            microphone: "granted",
            photos: "limited",
          }) as const,
      ),
    };
    const locationPlugin: LocationPluginLike = {
      requestPermissions: vi.fn(
        async () =>
          ({
            location: "granted",
            background: "granted",
          }) as const,
      ),
    };
    const screenCapturePlugin: ScreenCapturePluginLike = {
      requestPermissions: vi.fn(
        async () =>
          ({
            screenCapture: "prompt",
            microphone: "granted",
          }) as const,
      ),
    };
    const progress: ProactiveIosPermissionsProgress[] = [];

    const result = await requestProactiveIosPermissions({
      registry: permissionsRegistry,
      cameraPlugin,
      locationPlugin,
      screenCapturePlugin,
      onProgress: (next) => progress.push(next),
    });

    expect(permissionsRegistry.request).toHaveBeenCalledWith("calendar", {
      reason: "Read and update schedules for proactive planning.",
      feature: { app: "onboarding", action: "calendar.setup" },
    });
    expect(permissionsRegistry.request).toHaveBeenCalledWith("health", {
      reason: "Read sleep and biometric signals for proactive timing.",
      feature: { app: "onboarding", action: "health.setup" },
    });
    expect(permissionsRegistry.request).not.toHaveBeenCalledWith(
      "screentime",
      expect.anything(),
    );
    expect(permissionsRegistry.request).toHaveBeenCalledWith("notifications", {
      reason: "Send proactive reminders and follow-ups.",
      feature: { app: "onboarding", action: "notifications.setup" },
    });
    expect(cameraPlugin.requestPermissions).toHaveBeenCalled();
    expect(locationPlugin.requestPermissions).toHaveBeenCalled();
    expect(screenCapturePlugin.requestPermissions).toHaveBeenCalled();
    expect(result).toMatchObject({
      running: false,
      completed: 10,
      total: 10,
      granted: 8,
      blocked: 2,
      message:
        "8/10 proactive permissions are ready. Review the remaining permissions in Settings.",
    });
    expect(progress.at(-1)).toEqual(result);
  });

  it("skips the sweep outside native iOS", async () => {
    capacitorState.isNative = false;
    capacitorState.platform = "web";
    const permissionsRegistry = registry();

    const result = await requestProactiveIosPermissions({
      registry: permissionsRegistry,
    });

    expect(permissionsRegistry.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      running: false,
      completed: 0,
      total: 10,
      granted: 0,
      blocked: 0,
    });
  });
});

describe("getFriendlyNameFromUserId", () => {
  it("extracts and capitalizes name from email", () => {
    expect(getFriendlyNameFromUserId("john.doe@gmail.com")).toBe("John");
    expect(getFriendlyNameFromUserId("SARAH@example.com")).toBe("Sarah");
    expect(getFriendlyNameFromUserId("alice-smith@domain.org")).toBe("Alice");
  });

  it("extracts name from ENS domain", () => {
    expect(getFriendlyNameFromUserId("bob.eth")).toBe("Bob");
    expect(getFriendlyNameFromUserId("charlie.ETH")).toBe("Charlie");
  });

  it("returns null for wallet address", () => {
    expect(
      getFriendlyNameFromUserId("0x1234567890123456789012345678901234567890"),
    ).toBeNull();
  });

  it("handles standard usernames", () => {
    expect(getFriendlyNameFromUserId("david")).toBe("David");
    expect(getFriendlyNameFromUserId("emma_jones")).toBe("Emma");
  });

  it("returns null for invalid inputs", () => {
    expect(getFriendlyNameFromUserId(null)).toBeNull();
    expect(getFriendlyNameFromUserId("")).toBeNull();
    expect(getFriendlyNameFromUserId("   ")).toBeNull();
  });
});
