import { Capacitor } from "@capacitor/core";
import type {
  IPermissionsRegistry,
  PermissionFeatureRef,
  PermissionId,
  PermissionRestrictedReason,
  PermissionState,
  PermissionStatus,
} from "@elizaos/shared";
import {
  type CameraPermissionStatus,
  type CameraPluginLike,
  getCameraPlugin,
  getLocationPlugin,
  getScreenCapturePlugin,
  type LocationPluginLike,
  type LocationPermissionStatus,
  type ScreenCapturePermissionStatus,
  type ScreenCapturePluginLike,
} from "../bridge/native-plugins";
import { createMobileSignalsPermissionsRegistry } from "../platform/mobile-permissions-client";

type ProactivePermissionId = Extract<
  PermissionId,
  | "calendar"
  | "health"
  | "screentime"
  | "notifications"
  | "camera"
  | "microphone"
  | "location"
  | "screen-recording"
>;

type RegistryPermissionId = Extract<
  ProactivePermissionId,
  "calendar" | "health" | "screentime" | "notifications"
>;

type ProactivePermissionRequest = {
  id: RegistryPermissionId;
  label: string;
  reason: string;
  feature: PermissionFeatureRef;
  requestOnBoot?: boolean;
};

export interface ProactiveIosPermissionsProgress {
  running: boolean;
  message: string | null;
  completed: number;
  total: number;
  granted: number;
  blocked: number;
  states: readonly PermissionState[];
}

export interface RequestProactiveIosPermissionsOptions {
  registry?: IPermissionsRegistry;
  cameraPlugin?: CameraPluginLike;
  locationPlugin?: LocationPluginLike;
  screenCapturePlugin?: ScreenCapturePluginLike;
  onProgress?: (progress: ProactiveIosPermissionsProgress) => void;
}

let defaultProactiveIosPermissionsRequest: Promise<ProactiveIosPermissionsProgress> | null =
  null;

const PROACTIVE_IOS_PERMISSION_IDS: readonly ProactivePermissionId[] = [
  "calendar",
  "health",
  "screentime",
  "notifications",
  "camera",
  "microphone",
  "location",
  "screen-recording",
];

const REGISTRY_REQUESTS: readonly ProactivePermissionRequest[] = [
  {
    id: "calendar",
    label: "Calendar",
    reason: "Read and update schedules for proactive planning.",
    feature: { app: "onboarding", action: "calendar.setup" },
  },
  {
    id: "health",
    label: "Health",
    reason: "Read sleep and biometric signals for proactive timing.",
    feature: { app: "onboarding", action: "health.setup" },
  },
  {
    id: "screentime",
    label: "Screen Time",
    reason: "Read device-usage context for proactive focus and availability.",
    feature: { app: "onboarding", action: "screentime.setup" },
    requestOnBoot: false,
  },
  {
    id: "notifications",
    label: "Notifications",
    reason: "Send proactive reminders and follow-ups.",
    feature: { app: "onboarding", action: "notifications.setup" },
  },
];

export const EMPTY_PROACTIVE_IOS_PERMISSIONS_PROGRESS: ProactiveIosPermissionsProgress =
  {
    running: false,
    message: null,
    completed: 0,
    total: PROACTIVE_IOS_PERMISSION_IDS.length,
    granted: 0,
    blocked: 0,
    states: [],
  };

export function shouldRequestProactiveIosPermissions(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
}

function stateBlocked(state: PermissionState): boolean {
  return (
    state.status === "denied" ||
    state.status === "not-determined" ||
    state.status === "restricted"
  );
}

function progressFromStates(
  states: readonly PermissionState[],
  message: string | null,
  running: boolean,
): ProactiveIosPermissionsProgress {
  return {
    running,
    message,
    completed: states.length,
    total: PROACTIVE_IOS_PERMISSION_IDS.length,
    granted: states.filter((state) => state.status === "granted").length,
    blocked: states.filter(stateBlocked).length,
    states,
  };
}

function statusFromPrompt(value: "granted" | "denied" | "prompt"): {
  status: PermissionStatus;
  canRequest: boolean;
} {
  if (value === "granted") return { status: "granted", canRequest: false };
  if (value === "denied") return { status: "denied", canRequest: false };
  return { status: "not-determined", canRequest: true };
}

function stateForPermission(
  id: ProactivePermissionId,
  status: PermissionStatus,
  options: {
    canRequest?: boolean;
    reason?: string;
    restrictedReason?: PermissionRestrictedReason;
  } = {},
): PermissionState {
  return {
    id,
    status,
    lastChecked: Date.now(),
    canRequest: options.canRequest ?? false,
    platform: "ios",
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.restrictedReason
      ? { restrictedReason: options.restrictedReason }
      : {}),
  };
}

function unavailablePermissionState(
  id: ProactivePermissionId,
  reason: string,
): PermissionState {
  return stateForPermission(id, "not-applicable", {
    reason,
  });
}

function failedPermissionState(
  id: ProactivePermissionId,
  error: Error,
): PermissionState {
  return stateForPermission(id, "restricted", {
    reason: error.message,
    restrictedReason: "os_policy",
  });
}

function cameraPermissionStates(
  permissions: CameraPermissionStatus,
): readonly PermissionState[] {
  const camera = statusFromPrompt(permissions.camera);
  const microphone = statusFromPrompt(permissions.microphone);
  return [
    stateForPermission("camera", camera.status, {
      canRequest: camera.canRequest,
    }),
    stateForPermission("microphone", microphone.status, {
      canRequest: microphone.canRequest,
    }),
  ];
}

function locationPermissionState(
  permissions: LocationPermissionStatus,
): PermissionState {
  const foreground = statusFromPrompt(permissions.location);
  if (foreground.status !== "granted") {
    return stateForPermission("location", foreground.status, {
      canRequest: foreground.canRequest,
    });
  }
  if (permissions.background === "denied") {
    return stateForPermission("location", "denied", {
      reason: "Background location access is denied.",
    });
  }
  if (permissions.background === "prompt") {
    return stateForPermission("location", "not-determined", {
      canRequest: true,
      reason: "Background location access has not been granted.",
    });
  }
  return stateForPermission("location", "granted");
}

function screenCapturePermissionState(
  permissions: ScreenCapturePermissionStatus,
): PermissionState {
  if (permissions.screenCapture === "not_supported") {
    return unavailablePermissionState(
      "screen-recording",
      "Screen capture is not supported on this device.",
    );
  }
  if (permissions.screenCapture === "granted") {
    return stateForPermission("screen-recording", "granted");
  }
  if (permissions.screenCapture === "denied") {
    return stateForPermission("screen-recording", "denied");
  }
  return stateForPermission("screen-recording", "not-determined", {
    reason: "iOS prompts for screen capture when recording starts.",
  });
}

async function requestRegistryPermission(
  registry: IPermissionsRegistry,
  request: ProactivePermissionRequest,
): Promise<PermissionState> {
  if (request.requestOnBoot === false) {
    return stateForPermission(request.id, "restricted", {
      reason: `${request.label} authorization is deferred because iOS may open Settings.`,
      restrictedReason: "os_policy",
    });
  }
  const current = await registry.check(request.id);
  if (current.status === "granted" || !current.canRequest) {
    return current;
  }
  return registry.request(request.id, {
    reason: request.reason,
    feature: request.feature,
  });
}

async function requestCameraPermissions(
  plugin: CameraPluginLike,
): Promise<readonly PermissionState[]> {
  if (typeof plugin.requestPermissions !== "function") {
    return [
      unavailablePermissionState(
        "camera",
        "The camera bridge is not available in this build.",
      ),
      unavailablePermissionState(
        "microphone",
        "The camera bridge is not available in this build.",
      ),
    ];
  }
  return cameraPermissionStates(await plugin.requestPermissions());
}

async function requestLocationPermission(
  plugin: LocationPluginLike,
): Promise<PermissionState> {
  if (typeof plugin.requestPermissions !== "function") {
    return unavailablePermissionState(
      "location",
      "The location bridge is not available in this build.",
    );
  }
  return locationPermissionState(await plugin.requestPermissions());
}

async function requestScreenCapturePermission(
  plugin: ScreenCapturePluginLike,
): Promise<PermissionState> {
  if (typeof plugin.requestPermissions !== "function") {
    return unavailablePermissionState(
      "screen-recording",
      "The screen capture bridge is not available in this build.",
    );
  }
  return screenCapturePermissionState(await plugin.requestPermissions());
}

function finalMessage(progress: ProactiveIosPermissionsProgress): string {
  if (progress.blocked === 0) return "All proactive permissions are ready.";
  return `${progress.granted}/${progress.total} proactive permissions are ready. Review the remaining permissions in Settings.`;
}

export async function requestProactiveIosPermissions(
  options: RequestProactiveIosPermissionsOptions = {},
): Promise<ProactiveIosPermissionsProgress> {
  const usesDefaultPlugins =
    !options.registry &&
    !options.cameraPlugin &&
    !options.locationPlugin &&
    !options.screenCapturePlugin;
  if (usesDefaultPlugins && defaultProactiveIosPermissionsRequest) {
    const progress = await defaultProactiveIosPermissionsRequest;
    options.onProgress?.(progress);
    return progress;
  }

  const request = runProactiveIosPermissionsRequest(options);
  if (usesDefaultPlugins) {
    defaultProactiveIosPermissionsRequest = request;
  }
  return request;
}

async function runProactiveIosPermissionsRequest(
  options: RequestProactiveIosPermissionsOptions,
): Promise<ProactiveIosPermissionsProgress> {
  if (!shouldRequestProactiveIosPermissions()) {
    return EMPTY_PROACTIVE_IOS_PERMISSIONS_PROGRESS;
  }

  const registry =
    options.registry ?? createMobileSignalsPermissionsRegistry();
  const cameraPlugin = options.cameraPlugin ?? getCameraPlugin();
  const locationPlugin = options.locationPlugin ?? getLocationPlugin();
  const screenCapturePlugin =
    options.screenCapturePlugin ?? getScreenCapturePlugin();
  const states: PermissionState[] = [];
  const emit = (message: string | null, running: boolean) => {
    const progress = progressFromStates([...states], message, running);
    options.onProgress?.(progress);
    return progress;
  };

  emit("Requesting proactive iOS permissions", true);

  for (const request of REGISTRY_REQUESTS) {
    emit(`Requesting ${request.label} access`, true);
    try {
      states.push(await requestRegistryPermission(registry, request));
    } catch (error) {
      states.push(
        failedPermissionState(
          request.id,
          error instanceof Error
            ? error
            : new Error(`${request.label} permission request failed.`),
        ),
      );
    }
  }

  emit("Requesting camera and microphone access", true);
  try {
    states.push(...(await requestCameraPermissions(cameraPlugin)));
  } catch (error) {
    const failed =
      error instanceof Error
        ? error
        : new Error("Camera and microphone permission request failed.");
    states.push(failedPermissionState("camera", failed));
    states.push(failedPermissionState("microphone", failed));
  }

  emit("Requesting location access", true);
  try {
    states.push(await requestLocationPermission(locationPlugin));
  } catch (error) {
    states.push(
      failedPermissionState(
        "location",
        error instanceof Error
          ? error
          : new Error("Location permission request failed."),
      ),
    );
  }

  emit("Preparing screen capture access", true);
  try {
    states.push(await requestScreenCapturePermission(screenCapturePlugin));
  } catch (error) {
    states.push(
      failedPermissionState(
        "screen-recording",
        error instanceof Error
          ? error
          : new Error("Screen capture permission request failed."),
      ),
    );
  }

  const complete = progressFromStates([...states], null, false);
  return emit(finalMessage(complete), false);
}
