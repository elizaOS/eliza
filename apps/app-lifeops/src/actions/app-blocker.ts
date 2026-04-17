import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  getAppBlockerAccess,
  APP_BLOCKER_ACCESS_ERROR,
} from "../app-blocker/access.ts";
import {
  getAppBlockerStatus,
  startAppBlock,
  stopAppBlock,
} from "../app-blocker/engine.ts";

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function extractDurationMinutesFromText(text: string): number | null {
  const match = text.match(
    /(\d+)\s*(min(?:ute)?s?|hrs?|hours?)\b/i,
  );
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("h")) return amount * 60;
  return amount;
}

function extractPackageNamesFromText(text: string): string[] {
  const packageNamePattern = /\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,})\b/gi;
  const matches = text.match(packageNamePattern) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

export const blockAppsAction: Action = {
  name: "BLOCK_APPS",
  similes: [
    "BLOCK_APP",
    "BLOCK_APPLICATION",
    "APP_BLOCKER",
    "START_APP_BLOCK",
    "BLOCK_DISTRACTING_APPS",
    "SHIELD_APPS",
  ],
  description:
    "Admin-only. Block selected apps on the user's phone using native OS controls. " +
    "On iPhone, uses Family Controls to shield apps. On Android, uses Usage Access to detect and overlay blocked apps. " +
    "Pass app package names (Android) or previously selected app tokens (iPhone) to block.",
  descriptionCompressed: "Admin: block phone apps via native OS controls (Family Controls/Usage Access).",
  validate: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message, _state, options) => {
    const access = await getAppBlockerAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? APP_BLOCKER_ACCESS_ERROR,
      };
    }

    const status = await getAppBlockerStatus();
    if (!status.available) {
      return {
        success: false,
        text:
          status.reason ??
          "App blocking is not available on this device.",
      };
    }

    if (status.permissionStatus !== "granted") {
      return {
        success: false,
        text:
          status.reason ??
          "App blocking permissions have not been granted. Ask the user to grant permissions first.",
      };
    }

    // Extract parameters
    const params = options?.parameters as
      | {
          packageNames?: string[];
          appTokens?: string[];
          durationMinutes?: number | null;
        }
      | undefined;

    const packageNames = params?.packageNames ?? extractPackageNamesFromText(getMessageText(message));
    const appTokens = params?.appTokens;
    const durationMinutes =
      params?.durationMinutes ??
      extractDurationMinutesFromText(getMessageText(message));

    if (
      (!packageNames || packageNames.length === 0) &&
      (!appTokens || appTokens.length === 0)
    ) {
      return {
        success: false,
        text:
          "Could not determine which apps to block. " +
          "On Android, provide package names (e.g. com.twitter.android). " +
          "On iPhone, the user needs to select apps through the system picker first.",
      };
    }

    const result = await startAppBlock({
      packageNames: packageNames.length > 0 ? packageNames : undefined,
      appTokens: appTokens && appTokens.length > 0 ? appTokens : undefined,
      durationMinutes,
    });

    if (!result.success) {
      return {
        success: false,
        text: result.error ?? "Failed to start app block.",
      };
    }

    const countText = `${result.blockedCount} app${result.blockedCount !== 1 ? "s" : ""}`;
    const untilText = result.endsAt
      ? `until ${result.endsAt}`
      : "until you unblock";

    return {
      success: true,
      text: `Started blocking ${countText} ${untilText}.`,
      data: {
        blockedCount: result.blockedCount,
        endsAt: result.endsAt,
      },
    };
  },
  parameters: [
    {
      name: "packageNames",
      description:
        "Android package names to block, e.g. ['com.twitter.android', 'com.instagram.android']. Not used on iPhone.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "appTokens",
      description:
        "iPhone app tokens from a previous selectApps() call. Not used on Android.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "durationMinutes",
      description:
        "How long to block the apps, in minutes. Omit for indefinite block.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Block Twitter and Instagram for 2 hours." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started blocking 2 apps until the block expires.",
          action: "BLOCK_APPS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Block all my social media apps." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started blocking 4 apps until you unblock.",
          action: "BLOCK_APPS",
        },
      },
    ],
  ] as ActionExample[][],
};

export const unblockAppsAction: Action = {
  name: "UNBLOCK_APPS",
  similes: [
    "UNBLOCK_APP",
    "REMOVE_APP_BLOCK",
    "STOP_BLOCKING_APPS",
    "UNSHIELD_APPS",
  ],
  description:
    "Admin-only. Remove the current app block, unshielding all blocked apps.",
  descriptionCompressed: "Admin: remove app block, unshield all apps.",
  validate: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? APP_BLOCKER_ACCESS_ERROR,
      };
    }

    const status = await getAppBlockerStatus();
    if (!status.active) {
      return {
        success: true,
        text: "No app block is active right now.",
      };
    }

    const result = await stopAppBlock();
    if (!result.success) {
      return {
        success: false,
        text: result.error ?? "Failed to remove app block.",
      };
    }

    return {
      success: true,
      text: "Removed the app block. All apps are unblocked now.",
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Unblock my apps." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Removed the app block. All apps are unblocked now.",
          action: "UNBLOCK_APPS",
        },
      },
    ],
  ] as ActionExample[][],
};

export const getAppBlockStatusAction: Action = {
  name: "GET_APP_BLOCK_STATUS",
  similes: [
    "CHECK_APP_BLOCK_STATUS",
    "IS_APP_BLOCK_RUNNING",
    "APP_BLOCK_STATUS",
  ],
  description:
    "Admin-only. Check whether an app block is currently active and when it ends.",
  descriptionCompressed: "Admin: check if app block is active.",
  validate: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? APP_BLOCKER_ACCESS_ERROR,
      };
    }

    const status = await getAppBlockerStatus();
    if (!status.available) {
      return {
        success: false,
        text:
          status.reason ??
          "App blocking is not available on this device.",
      };
    }

    if (!status.active) {
      return {
        success: true,
        text: "No app block is active right now.",
        data: { active: false },
      };
    }

    const countText = `${status.blockedCount} app${status.blockedCount !== 1 ? "s" : ""}`;
    const untilText = status.endsAt
      ? `until ${status.endsAt}`
      : "until you remove it";

    return {
      success: true,
      text: `An app block is active for ${countText} ${untilText}.`,
      data: {
        active: true,
        blockedCount: status.blockedCount,
        blockedPackageNames: status.blockedPackageNames,
        endsAt: status.endsAt,
        engine: status.engine,
        platform: status.platform,
      },
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Is there an app block running?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "An app block is active for 3 apps until 2026-04-15T15:00:00.000Z.",
          action: "GET_APP_BLOCK_STATUS",
        },
      },
    ],
  ] as ActionExample[][],
};
