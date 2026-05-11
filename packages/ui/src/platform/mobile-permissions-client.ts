import type {
  IPermissionsRegistry,
  PermissionFeatureRef,
  PermissionId,
  PermissionState,
  PermissionStatus,
} from "@elizaos/shared";
import {
  getMobileSignalsPlugin,
  type MobileSignalsOpenSettingsResult,
  type MobileSignalsPermissionStatus,
  type MobileSignalsPluginLike,
  type MobileSignalsScreenTimeStatus,
  type MobileSignalsSettingsTarget,
  type MobileSignalsSetupAction,
} from "../bridge/native-plugins";
import { platform } from "./init";

type MobilePermissionId = Extract<
  PermissionId,
  "health" | "screentime" | "notifications"
>;

type PermissionClientLike = {
  getPermission(id: PermissionId): Promise<PermissionState>;
  requestPermission(id: PermissionId): Promise<PermissionState>;
  openPermissionSettings(id: PermissionId): Promise<void>;
};

const MOBILE_SIGNAL_PERMISSION_IDS = new Set<PermissionId>([
  "health",
  "screentime",
  "notifications",
]);

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

function stateFromMobileSignals(
  id: MobilePermissionId,
  permissions: MobileSignalsPermissionStatus,
): PermissionState {
  if (id === "health") return stateFromHealth(permissions);
  if (id === "screentime") return stateFromScreenTime(permissions);
  return stateFromNotifications(permissions);
}

function mobileSettingsTargetFor(
  id: PermissionId,
): MobileSignalsSettingsTarget {
  if (id === "health")
    return platform === "android" ? "healthConnect" : "health";
  if (id === "screentime") {
    return platform === "android" ? "usageAccess" : "screenTime";
  }
  if (id === "notifications") return "notification";
  return "app";
}

function isMobileSignalPermissionId(
  id: PermissionId,
): id is MobilePermissionId {
  return MOBILE_SIGNAL_PERMISSION_IDS.has(id);
}

export async function openMobilePermissionSettings(
  id: PermissionId,
  plugin: MobileSignalsPluginLike = getMobileSignalsPlugin(),
): Promise<MobileSignalsOpenSettingsResult | undefined> {
  if (typeof plugin.openSettings !== "function") return;
  return plugin.openSettings({ target: mobileSettingsTargetFor(id) });
}

export function createMobileSignalsPermissionsRegistry(
  plugin: MobileSignalsPluginLike = getMobileSignalsPlugin(),
  fallbackClient?: PermissionClientLike,
): IPermissionsRegistry {
  const states = new Map<PermissionId, PermissionState>();
  const subscribers = new Set<(state: PermissionState[]) => void>();

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
          canRequest: isMobileSignalPermissionId(id),
        })
      );
    },
    async check(id) {
      if (isMobileSignalPermissionId(id)) return checkMobilePermission(id);
      return checkFallback(id);
    },
    async request(id, opts) {
      const lastRequested = Date.now();

      if (!isMobileSignalPermissionId(id)) {
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

      if (id === "notifications") {
        const current = await checkMobilePermission(id);
        if (
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
      } else if (typeof plugin.requestPermissions === "function") {
        await plugin.requestPermissions({ target: "health" });
      }

      const next = await checkMobilePermission(id);
      return commit({
        ...next,
        lastRequested,
        lastBlockedFeature: next.lastBlockedFeature ?? {
          ...opts.feature,
          at: lastRequested,
        },
      });
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
