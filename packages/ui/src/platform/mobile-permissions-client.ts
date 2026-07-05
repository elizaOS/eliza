/**
 * Mobile permission client: maps the shared permission registry to the Capacitor
 * permission plugins and reports normalized states.
 */
import type {
  IPermissionsRegistry,
  PermissionFeatureRef,
  PermissionId,
  PermissionState,
  PermissionStatus,
} from "@elizaos/shared/contracts/permissions";
import {
  type AppBlockerPermissionResult,
  type AppBlockerPluginLike,
  type AppleCalendarPermissionStatus,
  type AppleCalendarPluginLike,
  type CameraPermissionStatus,
  type CameraPluginLike,
  type ContactsPermissionStatus,
  type ContactsPluginLike,
  getAppBlockerPlugin,
  getAppleCalendarPlugin,
  getCameraPlugin,
  getContactsPlugin,
  getLocationPlugin,
  getMessagesPlugin,
  getMobileSignalsPlugin,
  getPhonePlugin,
  getPushNotificationsPlugin,
  getScreenCapturePlugin,
  getSystemPlugin,
  getTalkModePlugin,
  type LocationPermissionStatus,
  type LocationPluginLike,
  type MessagesPermissionStatus,
  type MessagesPluginLike,
  type MobileSignalsOpenSettingsResult,
  type MobileSignalsPermissionStatus,
  type MobileSignalsPluginLike,
  type MobileSignalsScreenTimeStatus,
  type MobileSignalsSettingsTarget,
  type MobileSignalsSetupAction,
  type PhonePermissionStatus,
  type PushNotificationPermissionStatus,
  type PushNotificationsPluginLike,
  type ScreenCapturePermissionStatus,
  type ScreenCapturePluginLike,
  type SystemPluginLike,
  type TalkModePermissionStatus,
  type TalkModePluginLike,
} from "../bridge/native-plugins";
import { initPushRegistration } from "../state/notifications/push-registration";
import { platform } from "./init";

type MobilePermissionId = Extract<
  PermissionId,
  | "calendar"
  | "health"
  | "screentime"
  | "notifications"
  | "contacts"
  | "microphone"
  | "camera"
  | "location"
  | "screen-recording"
  | "speech-recognition"
  | "photos"
  | "phone"
  | "messages"
  | "wifi"
  | "bluetooth"
  | "app-blocking"
  | "usage-access"
  | "overlay"
  | "write-settings"
  | "local-network"
  | "battery-optimization"
>;

type PermissionClientLike = {
  getPermission(id: PermissionId): Promise<PermissionState>;
  requestPermission(id: PermissionId): Promise<PermissionState>;
  openPermissionSettings(id: PermissionId): Promise<void>;
};

const MOBILE_PERMISSION_IDS = new Set<PermissionId>([
  "calendar",
  "health",
  "screentime",
  "notifications",
  "contacts",
  "microphone",
  "camera",
  "location",
  "screen-recording",
  "speech-recognition",
  "photos",
  "phone",
  "messages",
  "wifi",
  "bluetooth",
  "app-blocking",
  "usage-access",
  "overlay",
  "write-settings",
  "local-network",
  "battery-optimization",
]);

interface NativePermissionPlugins {
  appBlocker?: AppBlockerPluginLike;
  camera?: CameraPluginLike;
  contacts?: ContactsPluginLike;
  location?: LocationPluginLike;
  messages?: MessagesPluginLike;
  phone?: {
    checkPermissions?: () => Promise<PhonePermissionStatus>;
    requestPermissions?: () => Promise<PhonePermissionStatus>;
  };
  screenCapture?: ScreenCapturePluginLike;
  system?: SystemPluginLike;
  talkMode?: TalkModePluginLike;
}

function currentMobilePlatform(): PermissionState["platform"] {
  if (platform === "ios" || platform === "android") return platform;
  return "web";
}

function defaultMobileState(
  id: PermissionId,
  status: PermissionStatus = "not-applicable",
  options: Partial<Omit<PermissionState, "id" | "status" | "lastChecked">> = {},
): PermissionState {
  return {
    id,
    status,
    lastChecked: Date.now(),
    canRequest: options.canRequest ?? false,
    platform: options.platform ?? currentMobilePlatform(),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.restrictedReason
      ? { restrictedReason: options.restrictedReason }
      : {}),
    ...(options.lastRequested ? { lastRequested: options.lastRequested } : {}),
    ...(options.lastBlockedFeature
      ? { lastBlockedFeature: options.lastBlockedFeature }
      : {}),
  };
}

type PromptLikePermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "prompt-with-rationale"
  | "limited"
  | "not_supported"
  | undefined
  | null;

function statusFromPromptLike(
  value: PromptLikePermissionState,
): PermissionStatus {
  if (value === "granted" || value === "limited") return "granted";
  if (value === "denied") return "denied";
  if (value === "not_supported") return "not-applicable";
  return "not-determined";
}

function canRequestPromptLike(value: PromptLikePermissionState): boolean {
  return (
    value === "prompt" ||
    value === "prompt-with-rationale" ||
    value === undefined ||
    value === null
  );
}

function stateFromPromptLike(
  id: PermissionId,
  value: PromptLikePermissionState,
  reason?: string,
): PermissionState {
  const status = statusFromPromptLike(value);
  return defaultMobileState(id, status, {
    canRequest: status === "not-determined" && canRequestPromptLike(value),
    restrictedReason:
      status === "not-applicable" ? "platform_unsupported" : undefined,
    reason:
      value === "limited" && !reason
        ? "Limited access is enabled; manage selected items in system settings."
        : reason,
  });
}

function stateFromCamera(
  id: Extract<MobilePermissionId, "camera" | "microphone" | "photos">,
  permissions: CameraPermissionStatus,
): PermissionState {
  if (id === "camera") return stateFromPromptLike(id, permissions.camera);
  if (id === "microphone") {
    return stateFromPromptLike(id, permissions.microphone);
  }
  return stateFromPromptLike(id, permissions.photos);
}

function stateFromTalkMode(
  id: Extract<MobilePermissionId, "microphone" | "speech-recognition">,
  permissions: TalkModePermissionStatus,
): PermissionState {
  if (id === "speech-recognition") {
    return stateFromPromptLike(id, permissions.speechRecognition);
  }
  return stateFromPromptLike(id, permissions.microphone);
}

function stateFromLocation(
  id: Extract<MobilePermissionId, "location" | "wifi">,
  permissions: LocationPermissionStatus,
): PermissionState {
  const reason =
    id === "wifi"
      ? "Android exposes Wi-Fi scan results only after Location access is allowed."
      : undefined;
  return stateFromPromptLike(id, permissions.location, reason);
}

function stateFromScreenCapture(
  permissions: ScreenCapturePermissionStatus,
): PermissionState {
  return stateFromPromptLike(
    "screen-recording",
    permissions.screenCapture,
    permissions.screenCapture === "prompt"
      ? "Screen capture shows an OS picker each time recording starts."
      : undefined,
  );
}

function stateFromContacts(
  permissions: ContactsPermissionStatus,
): PermissionState {
  return stateFromPromptLike("contacts", permissions.contacts);
}

function stateFromPhone(permissions: PhonePermissionStatus): PermissionState {
  return stateFromPromptLike("phone", permissions.phone);
}

function stateFromMessages(
  permissions: MessagesPermissionStatus,
): PermissionState {
  return stateFromPromptLike("messages", permissions.sms);
}

function stateFromAppBlocker(
  id: Extract<MobilePermissionId, "app-blocking" | "overlay">,
  permissions: AppBlockerPermissionResult,
): PermissionState {
  return defaultMobileState(id, permissions.status, {
    canRequest: permissions.canRequest,
    reason: permissions.reason,
  });
}

function stateFromWriteSettings(
  status: Awaited<
    ReturnType<NonNullable<SystemPluginLike["getDeviceSettings"]>>
  >,
): PermissionState {
  return defaultMobileState(
    "write-settings",
    status.canWriteSettings ? "granted" : "not-determined",
    {
      canRequest: !status.canWriteSettings,
      reason: status.canWriteSettings
        ? undefined
        : "Android requires granting Write Settings in the app's system settings screen.",
    },
  );
}

function normalizeMobileSignalsStatus(
  status: MobileSignalsPermissionStatus["status"],
): PermissionStatus {
  return status;
}

function statusFromSetupAction(
  action: MobileSignalsSetupAction | null,
): PermissionStatus {
  if (!action) return "not-applicable";
  if (action.status === "ready") return "granted";
  if (action.status === "unavailable") return "not-applicable";
  return "not-determined";
}

function findSetupAction(
  permissions: MobileSignalsPermissionStatus,
  ids: readonly MobileSignalsSetupAction["id"][],
): MobileSignalsSetupAction | null {
  return (
    permissions.setupActions.find((action) => ids.includes(action.id)) ?? null
  );
}

function restrictedReasonForScreenTime(
  screenTime: MobileSignalsScreenTimeStatus,
): PermissionState["restrictedReason"] {
  const reason = screenTime.reason ?? screenTime.provisioning.reason ?? "";
  if (reason.toLowerCase().includes("entitlement")) {
    return "entitlement_required";
  }
  if (!screenTime.supported) return "platform_unsupported";
  return "os_policy";
}

function stateFromScreenTime(
  permissions: MobileSignalsPermissionStatus,
): PermissionState {
  const screenTime = permissions.screenTime;
  const action = findSetupAction(permissions, [
    "screen_time_authorization",
    "android_usage_access",
  ]);
  const authorizationStatus = screenTime.authorization.status;

  if (authorizationStatus === "approved") {
    return defaultMobileState("screentime", "granted", {
      canRequest: false,
      reason: screenTime.reason ?? action?.reason ?? undefined,
    });
  }

  if (authorizationStatus === "denied") {
    return defaultMobileState("screentime", "denied", {
      canRequest: screenTime.authorization.canRequest,
      reason: screenTime.reason ?? action?.reason ?? undefined,
    });
  }

  if (authorizationStatus === "not-determined") {
    return defaultMobileState("screentime", "not-determined", {
      canRequest: screenTime.authorization.canRequest,
      reason: screenTime.reason ?? action?.reason ?? undefined,
    });
  }

  return defaultMobileState(
    "screentime",
    screenTime.supported ? "restricted" : "not-applicable",
    {
      canRequest: false,
      restrictedReason: screenTime.supported
        ? restrictedReasonForScreenTime(screenTime)
        : "platform_unsupported",
      reason: screenTime.reason ?? action?.reason ?? undefined,
    },
  );
}

function stateFromHealth(
  permissions: MobileSignalsPermissionStatus,
): PermissionState {
  return defaultMobileState(
    "health",
    normalizeMobileSignalsStatus(permissions.status),
    {
      canRequest: permissions.canRequest,
      reason: permissions.reason,
    },
  );
}

function stateFromNotifications(
  permissions: MobileSignalsPermissionStatus,
): PermissionState {
  const action = findSetupAction(permissions, ["notification_settings"]);
  return defaultMobileState("notifications", statusFromSetupAction(action), {
    canRequest: action?.canRequest ?? false,
    reason: action?.reason ?? undefined,
  });
}

function stateFromUsageAccess(
  permissions: MobileSignalsPermissionStatus,
): PermissionState {
  const action = findSetupAction(permissions, ["android_usage_access"]);
  if (permissions.screenTime.android?.usageAccessGranted) {
    return defaultMobileState("usage-access", "granted", {
      canRequest: false,
      reason: permissions.screenTime.reason ?? undefined,
    });
  }
  return defaultMobileState("usage-access", statusFromSetupAction(action), {
    canRequest: action?.canRequest ?? action?.canOpenSettings ?? false,
    reason: action?.reason ?? permissions.screenTime.reason ?? undefined,
  });
}

function stateFromSetupAction(
  id: Extract<MobilePermissionId, "battery-optimization" | "local-network">,
  permissions: MobileSignalsPermissionStatus,
  actionIds: readonly MobileSignalsSetupAction["id"][],
): PermissionState {
  const action = findSetupAction(permissions, actionIds);
  return defaultMobileState(id, statusFromSetupAction(action), {
    canRequest: action?.canRequest ?? action?.canOpenSettings ?? false,
    reason: action?.reason ?? undefined,
  });
}

function stateFromPushNotifications(
  permissions: PushNotificationPermissionStatus,
): PermissionState {
  switch (permissions.receive) {
    case "granted":
      return defaultMobileState("notifications", "granted", {
        canRequest: false,
      });
    case "denied":
      return defaultMobileState("notifications", "denied", {
        canRequest: false,
      });
    case "prompt":
    case "prompt-with-rationale":
      return defaultMobileState("notifications", "not-determined", {
        canRequest: true,
      });
    default:
      return defaultMobileState("notifications");
  }
}

function stateFromAppleCalendar(
  permissions: AppleCalendarPermissionStatus,
): PermissionState {
  const status =
    permissions.calendar === "prompt" ? "not-determined" : permissions.calendar;
  return defaultMobileState("calendar", status, {
    canRequest: permissions.canRequest,
    reason: permissions.reason ?? undefined,
    restrictedReason: status === "restricted" ? "os_policy" : undefined,
  });
}

function stateFromMobileSignals(
  id: MobilePermissionId,
  permissions: MobileSignalsPermissionStatus,
): PermissionState {
  if (id === "calendar") return defaultMobileState("calendar");
  if (id === "health") return stateFromHealth(permissions);
  if (id === "screentime") return stateFromScreenTime(permissions);
  if (id === "notifications") return stateFromNotifications(permissions);
  if (id === "usage-access") return stateFromUsageAccess(permissions);
  if (id === "battery-optimization") {
    return stateFromSetupAction("battery-optimization", permissions, [
      "battery_optimization",
    ]);
  }
  if (id === "local-network") {
    return stateFromSetupAction("local-network", permissions, [
      "local_network",
    ]);
  }
  return defaultMobileState(id);
}

function mobileSettingsTargetFor(
  id: PermissionId,
): MobileSignalsSettingsTarget {
  if (id === "health")
    return platform === "android" ? "healthConnect" : "health";
  if (id === "screentime") {
    return platform === "android" ? "usageAccess" : "screenTime";
  }
  if (id === "usage-access") return "usageAccess";
  if (id === "notifications") return "notification";
  if (id === "battery-optimization") return "batteryOptimization";
  if (id === "local-network") return "localNetwork";
  if (id === "write-settings") return "deviceSettings";
  return "app";
}

function isMobilePermissionId(id: PermissionId): id is MobilePermissionId {
  return MOBILE_PERMISSION_IDS.has(id);
}

export async function openMobilePermissionSettings(
  id: PermissionId,
  plugin: MobileSignalsPluginLike = getMobileSignalsPlugin(),
  systemPlugin: SystemPluginLike = getSystemPlugin(),
): Promise<MobileSignalsOpenSettingsResult | undefined> {
  if (
    id === "write-settings" &&
    typeof systemPlugin.openWriteSettings === "function"
  ) {
    await systemPlugin.openWriteSettings();
    return {
      opened: true,
      target: "deviceSettings",
      actualTarget: "deviceSettings",
      reason: null,
    };
  }
  if (typeof plugin.openSettings !== "function") return;
  return plugin.openSettings({ target: mobileSettingsTargetFor(id) });
}

export function createMobileSignalsPermissionsRegistry(
  plugin: MobileSignalsPluginLike = getMobileSignalsPlugin(),
  fallbackClient?: PermissionClientLike,
  appleCalendarPlugin: AppleCalendarPluginLike = getAppleCalendarPlugin(),
  pushNotificationsPlugin: PushNotificationsPluginLike = getPushNotificationsPlugin(),
  nativePlugins: NativePermissionPlugins = {},
  initPushRegistrationAfterGrant: () => Promise<void> = initPushRegistration,
): IPermissionsRegistry {
  const states = new Map<PermissionId, PermissionState>();
  const subscribers = new Set<(state: PermissionState[]) => void>();
  const native = {
    appBlocker: nativePlugins.appBlocker ?? getAppBlockerPlugin(),
    camera: nativePlugins.camera ?? getCameraPlugin(),
    contacts: nativePlugins.contacts ?? getContactsPlugin(),
    location: nativePlugins.location ?? getLocationPlugin(),
    messages: nativePlugins.messages ?? getMessagesPlugin(),
    phone: nativePlugins.phone ?? getPhonePlugin(),
    screenCapture: nativePlugins.screenCapture ?? getScreenCapturePlugin(),
    system: nativePlugins.system ?? getSystemPlugin(),
    talkMode: nativePlugins.talkMode ?? getTalkModePlugin(),
  };

  const notify = () => {
    const snapshot = Array.from(states.values());
    for (const subscriber of subscribers) {
      subscriber(snapshot);
    }
  };

  const commit = (state: PermissionState) => {
    states.set(state.id, state);
    notify();
    return state;
  };

  const checkMobilePermission = async (id: MobilePermissionId) => {
    if (id === "calendar") {
      if (typeof appleCalendarPlugin.checkPermissions !== "function") {
        return commit(
          defaultMobileState("calendar", "not-applicable", {
            restrictedReason: "platform_unsupported",
          }),
        );
      }
      return commit(
        stateFromAppleCalendar(await appleCalendarPlugin.checkPermissions()),
      );
    }
    if (id === "contacts") {
      if (typeof native.contacts.checkPermissions !== "function") {
        return commit(defaultMobileState("contacts"));
      }
      return commit(
        stateFromContacts(await native.contacts.checkPermissions()),
      );
    }
    if (id === "phone") {
      if (typeof native.phone.checkPermissions !== "function") {
        return commit(defaultMobileState("phone"));
      }
      return commit(stateFromPhone(await native.phone.checkPermissions()));
    }
    if (id === "messages") {
      if (typeof native.messages.checkPermissions !== "function") {
        return commit(defaultMobileState("messages"));
      }
      return commit(
        stateFromMessages(await native.messages.checkPermissions()),
      );
    }
    if (id === "camera" || id === "photos") {
      if (typeof native.camera.checkPermissions !== "function") {
        return commit(defaultMobileState(id));
      }
      return commit(
        stateFromCamera(id, await native.camera.checkPermissions()),
      );
    }
    if (id === "microphone") {
      if (typeof native.talkMode.checkPermissions === "function") {
        return commit(
          stateFromTalkMode(
            "microphone",
            await native.talkMode.checkPermissions(),
          ),
        );
      }
      if (typeof native.camera.checkPermissions === "function") {
        return commit(
          stateFromCamera("microphone", await native.camera.checkPermissions()),
        );
      }
      return commit(defaultMobileState("microphone"));
    }
    if (id === "speech-recognition") {
      if (typeof native.talkMode.checkPermissions !== "function") {
        return commit(defaultMobileState("speech-recognition"));
      }
      return commit(
        stateFromTalkMode(
          "speech-recognition",
          await native.talkMode.checkPermissions(),
        ),
      );
    }
    if (id === "location" || id === "wifi") {
      if (typeof native.location.checkPermissions !== "function") {
        return commit(defaultMobileState(id));
      }
      return commit(
        stateFromLocation(id, await native.location.checkPermissions()),
      );
    }
    if (id === "screen-recording") {
      if (typeof native.screenCapture.checkPermissions !== "function") {
        return commit(defaultMobileState("screen-recording"));
      }
      return commit(
        stateFromScreenCapture(await native.screenCapture.checkPermissions()),
      );
    }
    if (id === "app-blocking" || id === "overlay") {
      if (typeof native.appBlocker.checkPermissions !== "function") {
        return commit(defaultMobileState(id));
      }
      return commit(
        stateFromAppBlocker(id, await native.appBlocker.checkPermissions()),
      );
    }
    if (id === "write-settings") {
      if (typeof native.system.getDeviceSettings !== "function") {
        return commit(defaultMobileState("write-settings"));
      }
      return commit(
        stateFromWriteSettings(await native.system.getDeviceSettings()),
      );
    }
    if (id === "bluetooth") {
      return commit(
        defaultMobileState("bluetooth", "not-determined", {
          canRequest: true,
          reason:
            "Bluetooth permission is granted by the OS when a nearby accessory flow asks for it.",
        }),
      );
    }
    if (id === "notifications") {
      if (typeof pushNotificationsPlugin.checkPermissions === "function") {
        return commit(
          stateFromPushNotifications(
            await pushNotificationsPlugin.checkPermissions(),
          ),
        );
      }
    }
    if (typeof plugin.checkPermissions !== "function") {
      return commit(defaultMobileState(id));
    }
    const permissions = await plugin.checkPermissions();
    return commit(stateFromMobileSignals(id, permissions));
  };

  const checkFallback = async (id: PermissionId) => {
    if (fallbackClient) {
      return commit(await fallbackClient.getPermission(id));
    }
    return commit(defaultMobileState(id));
  };

  return {
    get(id) {
      return (
        states.get(id) ??
        defaultMobileState(id, "not-determined", {
          canRequest: isMobilePermissionId(id),
        })
      );
    },
    async check(id) {
      if (isMobilePermissionId(id)) return checkMobilePermission(id);
      return checkFallback(id);
    },
    async request(id, opts) {
      const lastRequested = Date.now();

      if (!isMobilePermissionId(id)) {
        if (fallbackClient) {
          const next = await fallbackClient.requestPermission(id);
          return commit({
            ...next,
            lastRequested,
            lastBlockedFeature: next.lastBlockedFeature ?? {
              ...opts.feature,
              at: lastRequested,
            },
          });
        }
        return commit(defaultMobileState(id, "not-applicable"));
      }

      let requestedState: PermissionState | null = null;
      if (id === "calendar") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof appleCalendarPlugin.requestPermissions === "function"
        ) {
          await appleCalendarPlugin.requestPermissions();
        } else {
          await openMobilePermissionSettings(id, plugin);
        }
      } else if (id === "contacts") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.contacts.requestPermissions === "function"
        ) {
          requestedState = stateFromContacts(
            await native.contacts.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "phone") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.phone.requestPermissions === "function"
        ) {
          requestedState = stateFromPhone(
            await native.phone.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "messages") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.messages.requestPermissions === "function"
        ) {
          requestedState = stateFromMessages(
            await native.messages.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "camera" || id === "photos") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.camera.requestPermissions === "function"
        ) {
          requestedState = stateFromCamera(
            id,
            await native.camera.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "microphone") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.talkMode.requestPermissions === "function"
        ) {
          requestedState = stateFromTalkMode(
            "microphone",
            await native.talkMode.requestPermissions(),
          );
        } else if (
          current.canRequest &&
          typeof native.camera.requestPermissions === "function"
        ) {
          requestedState = stateFromCamera(
            "microphone",
            await native.camera.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "speech-recognition") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.talkMode.requestPermissions === "function"
        ) {
          requestedState = stateFromTalkMode(
            "speech-recognition",
            await native.talkMode.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "location" || id === "wifi") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.location.requestPermissions === "function"
        ) {
          requestedState = stateFromLocation(
            id,
            await native.location.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "screen-recording") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.screenCapture.requestPermissions === "function"
        ) {
          requestedState = stateFromScreenCapture(
            await native.screenCapture.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "notifications") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof pushNotificationsPlugin.requestPermissions === "function"
        ) {
          requestedState = stateFromPushNotifications(
            await pushNotificationsPlugin.requestPermissions(),
          );
        } else if (
          current.canRequest &&
          typeof plugin.requestPermissions === "function"
        ) {
          await plugin.requestPermissions({ target: "notifications" });
        } else {
          await openMobilePermissionSettings(id, plugin);
        }
      } else if (id === "screentime") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof plugin.requestPermissions === "function"
        ) {
          await plugin.requestPermissions({ target: "screenTime" });
        } else {
          await openMobilePermissionSettings(id, plugin);
        }
      } else if (
        id === "usage-access" ||
        id === "battery-optimization" ||
        id === "local-network" ||
        id === "bluetooth"
      ) {
        await openMobilePermissionSettings(id, plugin, native.system);
      } else if (id === "app-blocking" || id === "overlay") {
        const current = await checkMobilePermission(id);
        if (
          current.canRequest &&
          typeof native.appBlocker.requestPermissions === "function"
        ) {
          requestedState = stateFromAppBlocker(
            id,
            await native.appBlocker.requestPermissions(),
          );
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (id === "write-settings") {
        if (typeof native.system.openWriteSettings === "function") {
          await native.system.openWriteSettings();
        } else {
          await openMobilePermissionSettings(id, plugin, native.system);
        }
      } else if (typeof plugin.requestPermissions === "function") {
        await plugin.requestPermissions({ target: "health" });
      }

      const next = requestedState ?? (await checkMobilePermission(id));
      if (id === "notifications" && next.status === "granted") {
        await initPushRegistrationAfterGrant();
      }
      return commit({
        ...next,
        lastRequested,
        lastBlockedFeature: next.lastBlockedFeature ?? {
          ...opts.feature,
          at: lastRequested,
        },
      });
    },
    async openSettings(id) {
      const result = await openMobilePermissionSettings(
        id,
        plugin,
        native.system,
      );
      return result?.opened === true;
    },
    recordBlock(id, feature: PermissionFeatureRef) {
      const current =
        states.get(id) ?? defaultMobileState(id, "not-determined");
      commit({
        ...current,
        lastBlockedFeature: {
          ...feature,
          at: Date.now(),
        },
      });
    },
    list() {
      return Array.from(states.values());
    },
    pending() {
      return Array.from(states.values()).filter(
        (state) =>
          state.status === "not-determined" ||
          Boolean(state.lastBlockedFeature),
      );
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    registerProber() {
      // Mobile permissions are owned by the native MobileSignals plugin.
    },
  };
}
