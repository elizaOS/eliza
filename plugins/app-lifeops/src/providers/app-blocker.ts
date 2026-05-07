import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { getAppBlockerAccess } from "../app-blocker/access.ts";
import { getCachedAppBlockerStatus } from "../app-blocker/engine.ts";

export const appBlockerProvider: Provider = {
  name: "appBlocker",
  description:
    "Owner-only provider for the native mobile app blocker integration (Family Controls on iPhone, Usage Access overlay on Android)",
  descriptionCompressed: "Owner: mobile app blocker integration.",
  dynamic: true,
  contexts: ["screen_time", "settings"],
  contextGate: { anyOf: ["screen_time", "settings"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const access = await getAppBlockerAccess(runtime, message);
    if (!access.allowed) {
      return {
        text: "",
        values: { appBlockerAuthorized: false },
        data: { appBlockerAuthorized: false },
      };
    }

    let status;
    try {
      status = await getCachedAppBlockerStatus();
    } catch {
      return {
        text: "App blocking plugin is not loaded on this device.",
        values: {
          appBlockerAuthorized: true,
          appBlockerAvailable: false,
        },
        data: {
          appBlockerAuthorized: true,
          appBlockerAvailable: false,
        },
      };
    }

    if (!status.available) {
      return {
        text: status.reason ?? "App blocking is not available on this device.",
        values: {
          appBlockerAuthorized: true,
          appBlockerAvailable: false,
          appBlockerEngine: status.engine,
          appBlockerPlatform: status.platform,
        },
        data: {
          appBlockerAuthorized: true,
          appBlockerAvailable: false,
          appBlockerEngine: status.engine,
          appBlockerPlatform: status.platform,
        },
      };
    }

    try {
      const statusLine = status.active
        ? status.endsAt
          ? `An app block is active (${status.blockedCount} apps) until ${status.endsAt}.`
          : `An app block is active (${status.blockedCount} apps) until you remove it.`
        : "No app block is active right now.";

      const permissionLine =
        status.permissionStatus === "granted"
          ? "Eliza has permission to block apps on this device."
          : (status.reason ??
            "App blocking permissions have not been granted yet.");

      return {
        text: [statusLine, permissionLine].join(" "),
        values: {
          appBlockerAuthorized: true,
          appBlockerAvailable: true,
          appBlockerActive: status.active,
          appBlockerBlockedCount: status.blockedCount,
          appBlockerEndsAt: status.endsAt,
          appBlockerEngine: status.engine,
          appBlockerPlatform: status.platform,
          appBlockerPermissionStatus: status.permissionStatus,
        },
        data: {
          appBlockerAuthorized: true,
          appBlockerAvailable: true,
          appBlockerActive: status.active,
          appBlockerBlockedCount: status.blockedCount,
          appBlockerBlockedPackageNames: status.blockedPackageNames.slice(0, 25),
          appBlockerEndsAt: status.endsAt,
          appBlockerEngine: status.engine,
          appBlockerPlatform: status.platform,
          appBlockerPermissionStatus: status.permissionStatus,
        },
      };
    } catch (error) {
      return {
        text: "App blocking status unavailable.",
        values: {
          appBlockerAuthorized: true,
          appBlockerAvailable: false,
        },
        data: {
          appBlockerAuthorized: true,
          appBlockerAvailable: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
