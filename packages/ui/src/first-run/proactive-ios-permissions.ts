import { Capacitor } from "@capacitor/core";
import type {
  IPermissionsRegistry,
  PermissionFeatureRef,
  PermissionId,
  PermissionRestrictedReason,
  PermissionState,
  PermissionStatus,
} from "@elizaos/shared";
import { useEffect, useState } from "react";
import {
  type CameraPermissionStatus,
  type CameraPluginLike,
  type ContactsPluginLike,
  getCameraPlugin,
  getContactsPlugin,
  getLocationPlugin,
  getScreenCapturePlugin,
  type LocationPermissionStatus,
  type LocationPluginLike,
  type ScreenCapturePermissionStatus,
  type ScreenCapturePluginLike,
} from "../bridge/native-plugins";
import { createMobileSignalsPermissionsRegistry } from "../platform/mobile-permissions-client";
import { useApp } from "../state";

type ProactivePermissionId = Extract<
  PermissionId,
  | "calendar"
  | "contacts"
  | "health"
  | "reminders"
  | "screentime"
  | "notifications"
  | "camera"
  | "microphone"
  | "location"
  | "screen-recording"
>;

type RegistryPermissionId = Extract<
  ProactivePermissionId,
  | "calendar"
  | "contacts"
  | "health"
  | "reminders"
  | "screentime"
  | "notifications"
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
  contactsPlugin?: ContactsPluginLike;
  locationPlugin?: LocationPluginLike;
  screenCapturePlugin?: ScreenCapturePluginLike;
  onProgress?: (progress: ProactiveIosPermissionsProgress) => void;
}

let defaultProactiveIosPermissionsRequest: Promise<ProactiveIosPermissionsProgress> | null =
  null;

const PROACTIVE_IOS_PERMISSION_IDS: readonly ProactivePermissionId[] = [
  "contacts",
  "calendar",
  "reminders",
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
    id: "contacts",
    label: "Contacts",
    reason: "Read your name and contacts for personalized interactions.",
    feature: { app: "onboarding", action: "contacts.setup" },
  },
  {
    id: "calendar",
    label: "Calendar",
    reason: "Read and update schedules for proactive planning.",
    feature: { app: "onboarding", action: "calendar.setup" },
  },
  {
    id: "reminders",
    label: "Reminders",
    reason: "Read and create reminders for proactive task management.",
    feature: { app: "onboarding", action: "reminders.setup" },
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

// ── Owner name persistence ────────────────────────────────────────────

const OWNER_NAME_KEY = "eliza:owner-given-name";
const OWNER_FULL_NAME_KEY = "eliza:owner-full-name";
const OWNER_NAME_CHANGED_EVENT = "eliza:owner-name-changed";

/**
 * Returns the user's given (first) name if it has been resolved from
 * Contacts or the device name during the proactive permission sweep.
 */
export function getPersistedOwnerGivenName(): string | null {
  try {
    return globalThis.localStorage?.getItem(OWNER_NAME_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Returns the user's full name if resolved during the permission sweep.
 */
export function getPersistedOwnerFullName(): string | null {
  try {
    return (
      globalThis.localStorage?.getItem(OWNER_FULL_NAME_KEY)?.trim() || null
    );
  } catch {
    return null;
  }
}

export function getFriendlyNameFromUserId(
  userId: string | null,
): string | null {
  if (!userId) return null;
  const clean = userId.trim();
  if (!clean) return null;

  if (clean.includes("@")) {
    const localPart = clean.split("@")[0];
    const firstSegment = localPart.split(/[^a-zA-Z0-9]/)[0];
    if (firstSegment) {
      return (
        firstSegment.charAt(0).toUpperCase() +
        firstSegment.slice(1).toLowerCase()
      );
    }
  }

  if (clean.toLowerCase().endsWith(".eth")) {
    const prefix = clean.slice(0, -4);
    const firstSegment = prefix.split(/[^a-zA-Z0-9]/)[0];
    if (firstSegment) {
      return (
        firstSegment.charAt(0).toUpperCase() +
        firstSegment.slice(1).toLowerCase()
      );
    }
  }

  if (clean.startsWith("0x")) {
    return null;
  }

  if (/^[a-zA-Z0-9._-]{1,20}$/.test(clean)) {
    const firstSegment = clean.split(/[^a-zA-Z0-9]/)[0];
    if (firstSegment) {
      return (
        firstSegment.charAt(0).toUpperCase() +
        firstSegment.slice(1).toLowerCase()
      );
    }
  }

  return null;
}

export function useOwnerGivenName(): string | null {
  const [name, setName] = useState(getPersistedOwnerGivenName);
  const { elizaCloudUserId } = useApp();

  useEffect(() => {
    const current = getPersistedOwnerGivenName();
    if (current !== name) setName(current);

    if (typeof document === "undefined") return;
    const handler = () => setName(getPersistedOwnerGivenName());
    document.addEventListener(OWNER_NAME_CHANGED_EVENT, handler);
    return () =>
      document.removeEventListener(OWNER_NAME_CHANGED_EVENT, handler);
  }, [name]);

  if (elizaCloudUserId) {
    const friendlyName = getFriendlyNameFromUserId(elizaCloudUserId);
    if (friendlyName) return friendlyName;
  }

  return name;
}

function persistOwnerName(givenName: string, fullName?: string): void {
  try {
    globalThis.localStorage?.setItem(OWNER_NAME_KEY, givenName);
    if (fullName) {
      globalThis.localStorage?.setItem(OWNER_FULL_NAME_KEY, fullName);
    }
    if (typeof document !== "undefined") {
      document.dispatchEvent(new Event(OWNER_NAME_CHANGED_EVENT));
    }
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Parse the user's first name from a device name like "Sarah's iPhone".
 */
function parseGivenNameFromDeviceName(deviceName: string): string | null {
  const suffixes = [
    "'s iPhone",
    "'s iPad",
    "'s iPod",
    "\u2019s iPhone",
    "\u2019s iPad",
    "\u2019s iPod",
    "'s iPhone",
    "'s iPad",
  ];
  for (const suffix of suffixes) {
    if (deviceName.endsWith(suffix)) {
      const name = deviceName.slice(0, -suffix.length).trim();
      if (name.length > 0 && name.length < 40) return name;
    }
  }
  return null;
}

/**
 * After contacts permission is granted, attempt to read the user's name
 * from their contacts list (looking for the "me" card or owner-like contact),
 * falling back to parsing the device name.
 */
async function resolveOwnerName(
  contactsPlugin: ContactsPluginLike,
): Promise<void> {
  // Skip if already resolved
  if (getPersistedOwnerGivenName()) return;

  try {
    // The ElizaContacts plugin may have a getOwnerInfo method
    const ownerInfo = contactsPlugin as ContactsPluginLike & {
      getOwnerInfo?: () => Promise<{
        givenName?: string;
        familyName?: string;
        nickname?: string;
        displayName?: string;
      }>;
    };
    if (typeof ownerInfo.getOwnerInfo === "function") {
      const info = await ownerInfo.getOwnerInfo();
      const given = info.givenName?.trim() || info.nickname?.trim();
      if (given) {
        const full = [info.givenName, info.familyName]
          .filter((s) => s?.trim())
          .join(" ")
          .trim();
        persistOwnerName(given, full || given);
        return;
      }
    }

    // Fallback: list contacts and look for one with the "me" flag or
    // match the device name. Most devices expose the owner as the first
    // starred contact or via the device name.
    if (typeof contactsPlugin.listContacts === "function") {
      const result = await contactsPlugin.listContacts({ limit: 5 });
      const contacts = result?.contacts ?? [];
      // The first starred contact is often the owner
      const starred = contacts.find((c) => c.starred && c.displayName);
      if (starred) {
        const parts = starred.displayName.split(/\s+/);
        const given = parts[0] ?? starred.displayName;
        persistOwnerName(given, starred.displayName);
        return;
      }
    }
  } catch {
    // Contacts plugin may not be available — fall through to device name
  }

  // Final fallback: try reading the device name
  try {
    const { Device } = await import("@capacitor/device");
    const info = await Device.getInfo();
    const deviceName = info?.name;
    if (deviceName) {
      const parsed = parseGivenNameFromDeviceName(deviceName);
      if (parsed) {
        persistOwnerName(parsed, parsed);
      }
    }
  } catch {
    // Device plugin unavailable
  }
}

async function runProactiveIosPermissionsRequest(
  options: RequestProactiveIosPermissionsOptions,
): Promise<ProactiveIosPermissionsProgress> {
  if (!shouldRequestProactiveIosPermissions()) {
    return EMPTY_PROACTIVE_IOS_PERMISSIONS_PROGRESS;
  }

  const registry = options.registry ?? createMobileSignalsPermissionsRegistry();
  const cameraPlugin = options.cameraPlugin ?? getCameraPlugin();
  const contactsPlugin = options.contactsPlugin ?? getContactsPlugin();
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

  // Resolve the owner's name in the background after the sweep.
  // This is non-blocking — the greeting will pick it up on next render.
  void resolveOwnerName(contactsPlugin);

  return emit(finalMessage(complete), false);
}
