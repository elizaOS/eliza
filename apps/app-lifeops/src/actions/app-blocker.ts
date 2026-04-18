import type {
  Action,
  ActionExample,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import {
  getAppBlockerAccess,
  APP_BLOCKER_ACCESS_ERROR,
} from "../app-blocker/access.ts";
import {
  getInstalledApps,
  getAppBlockerStatus,
  startAppBlock,
  stopAppBlock,
} from "../app-blocker/engine.ts";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

type BlockAppsParameters = {
  packageNames?: string[];
  appTokens?: string[];
  durationMinutes?: number | null;
};

type AppBlockPlan = {
  shouldAct?: boolean | null;
  response?: string;
  packageNames: string[];
  durationMinutes?: number | null;
};

type InstalledAppEntry = Awaited<ReturnType<typeof getInstalledApps>>[number];

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePackageNames(
  value: unknown,
  allowedPackageNames?: ReadonlySet<string>,
): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s*\|\|\s*|,/)
      : [];
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  const unique = [...new Set(normalized)];
  if (!allowedPackageNames) {
    return unique;
  }
  return unique.filter((item) => allowedPackageNames.has(item));
}

function normalizeDurationMinutes(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return undefined;
    }
    if (
      trimmed === "indefinite" ||
      trimmed === "manual" ||
      trimmed === "until-unblocked" ||
      trimmed === "forever"
    ) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return undefined;
}

async function resolveAppBlockPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  status: Awaited<ReturnType<typeof getAppBlockerStatus>>;
  installedApps: InstalledAppEntry[];
}): Promise<AppBlockPlan> {
  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 8,
    })
  ).join("\n");
  const currentMessage = getMessageText(args.message).trim();
  const allowedPackageNames = new Set(
    args.installedApps.map((app) => app.packageName.toLowerCase()),
  );
  const prompt = [
    "Plan the app blocking action for this request.",
    "Use the current request plus recent conversation context.",
    "Return a JSON object with exactly these fields:",
    "  shouldAct: boolean",
    "  response: short natural-language reply when clarification is needed",
    "  packageNames: array of Android package names to block",
    "  durationMinutes: positive integer for a timed block, or null for an indefinite/manual block",
    "",
    `Current platform: ${args.status.platform}`,
    "Rules:",
    "- If the platform is android, choose packageNames only from the installed-app inventory below.",
    "- Never invent package names.",
    "- If the request is vague, asks for help, or names apps you cannot map safely, set shouldAct=false and ask for the missing detail.",
    "- If the platform is ios and there are no explicit app tokens, set shouldAct=false and tell the user to select apps through the system picker in the mobile UI first.",
    "- Use durationMinutes=null only when the user explicitly wants the block to last until manual removal.",
    "",
    "Installed Android apps:",
    args.installedApps.length > 0
      ? args.installedApps
          .map((app) => `- ${app.displayName} => ${app.packageName}`)
          .join("\n")
      : "(none available or not applicable)",
    "",
    "Examples:",
    '  "Block Twitter and Instagram for 2 hours" on Android -> {"shouldAct":true,"response":null,"packageNames":["com.twitter.android","com.instagram.android"],"durationMinutes":120}',
    '  "Block social apps" with no safe package matches -> {"shouldAct":false,"response":"Tell me which installed apps to block so I can match them exactly on your device.","packageNames":[],"durationMinutes":null}',
    '  "Block my apps" on iOS without selected app tokens -> {"shouldAct":false,"response":"Select the iPhone apps in the mobile app picker first, then I can start the block.","packageNames":[],"durationMinutes":null}',
    "",
    "Return ONLY valid JSON.",
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
    if (!parsed) {
      return {
        packageNames: [],
        shouldAct: null,
      };
    }
    return {
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
      packageNames: normalizePackageNames(
        parsed.packageNames ?? parsed.packages,
        allowedPackageNames,
      ),
      durationMinutes: normalizeDurationMinutes(parsed.durationMinutes),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:app-blocker",
        error: error instanceof Error ? error.message : String(error),
      },
      "App blocker planning model call failed",
    );
    return {
      packageNames: [],
      shouldAct: null,
    };
  }
}

export const blockAppsAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
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
    "Use this for requests like 'block all games on my phone until 6pm' or 'block the Slack app while I focus on deep work'. " +
    "Pass app package names (Android) or previously selected app tokens (iPhone) to block.",
  descriptionCompressed: "Admin: block phone apps via native OS controls (Family Controls/Usage Access).",
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message, state, options) => {
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

    const params = options?.parameters as BlockAppsParameters | undefined;
    const explicitPackageNames = normalizePackageNames(params?.packageNames);
    const appTokens =
      Array.isArray(params?.appTokens) && params.appTokens.length > 0
        ? params.appTokens.filter(
            (token): token is string => typeof token === "string" && token.length > 0,
          )
        : undefined;
    const explicitDurationMinutes = normalizeDurationMinutes(
      params?.durationMinutes,
    );

    let installedApps: InstalledAppEntry[] = [];
    if (status.platform === "android") {
      try {
        installedApps = await getInstalledApps();
      } catch (error) {
        runtime.logger?.warn?.(
          {
            src: "action:app-blocker",
            error: error instanceof Error ? error.message : String(error),
          },
          "App blocker installed-app lookup failed",
        );
      }
    }

    const llmPlan =
      explicitPackageNames.length === 0 && !appTokens
        ? await resolveAppBlockPlanWithLlm({
            runtime,
            message,
            state,
            status,
            installedApps,
          })
        : null;

    if (
      llmPlan?.shouldAct === false &&
      explicitPackageNames.length === 0 &&
      !appTokens
    ) {
      return {
        success: true,
        text:
          llmPlan.response ??
          (status.platform === "ios"
            ? "Select the iPhone apps in the mobile app picker first, then I can start the block."
            : "Tell me which installed apps to block so I can match them exactly on your device."),
        data: { noop: true },
      };
    }

    const packageNames =
      explicitPackageNames.length > 0
        ? explicitPackageNames
        : llmPlan?.packageNames ?? [];
    const durationMinutes =
      explicitDurationMinutes !== undefined
        ? explicitDurationMinutes
        : llmPlan?.durationMinutes;

    if (
      (!packageNames || packageNames.length === 0) &&
      (!appTokens || appTokens.length === 0)
    ) {
      return {
        success: false,
        text:
          llmPlan?.response ??
          (status.platform === "ios"
            ? "Select the iPhone apps through the system picker first, then I can start the block."
            : "I couldn’t determine which installed apps to block on this device. Name the apps clearly so I can match them against the device inventory."),
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
