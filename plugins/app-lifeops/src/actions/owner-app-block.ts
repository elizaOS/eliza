import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseToonKeyValue,
  runWithTrajectoryContext,
} from "@elizaos/core";
import {
  APP_BLOCKER_ACCESS_ERROR,
  getAppBlockerAccess,
} from "../app-blocker/access.ts";
import {
  getAppBlockerStatus,
  getInstalledApps,
  startAppBlock,
  stopAppBlock,
} from "../app-blocker/engine.ts";
import { recentConversationTexts as collectRecentConversationTexts } from "./lib/recent-context.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";
import { formatPromptSection } from "./lib/prompt-format.js";

const ACTION_NAME = "OWNER_APP_BLOCK";

type AppBlockSubaction = "block" | "unblock" | "status";

interface AppBlockParams {
  intent?: string;
  packageNames?: string[];
  appTokens?: string[];
  durationMinutes?: number | null;
}

const SUBACTIONS: SubactionsMap<AppBlockSubaction> = {
  block: {
    description:
      "Start a phone-app block on the selected apps for an optional duration. " +
      "Android: requires packageNames from the installed-app inventory. " +
      "iOS: requires appTokens from a previous Family Controls picker selection.",
    descriptionCompressed:
      "block phone apps(packages|tokens duration?) iOS-Family-Controls Android-Usage-Access owner",
    required: ["intent"],
    optional: ["packageNames", "appTokens", "durationMinutes"],
  },
  unblock: {
    description: "Remove the active phone-app block, unshielding all apps.",
    descriptionCompressed: "unblock phone apps clear shield owner",
    required: [],
  },
  status: {
    description:
      "Report whether a phone-app block is currently active and when it ends.",
    descriptionCompressed: "phone-app-block active+endsAt owner",
    required: [],
  },
};

type InstalledAppEntry = Awaited<ReturnType<typeof getInstalledApps>>[number];
type AppBlockerStatus = Awaited<ReturnType<typeof getAppBlockerStatus>>;

interface AppBlockPlan {
  shouldAct: boolean | null;
  response?: string;
  packageNames: string[];
  durationMinutes?: number | null;
}

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
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
      ? value.slice(0, 10_000).split(/\s{0,256}\|\|\s{0,256}|,/)
      : [];
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  const unique = [...new Set(normalized)];
  if (!allowedPackageNames) return unique;
  return unique.filter((item) => allowedPackageNames.has(item));
}

function normalizeDurationMinutes(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (
      trimmed === "indefinite" ||
      trimmed === "manual" ||
      trimmed === "until-unblocked" ||
      trimmed === "forever"
    ) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return undefined;
}

function normalizeAppTokens(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tokens = value.filter(
    (token): token is string => typeof token === "string" && token.length > 0,
  );
  return tokens.length > 0 ? tokens : undefined;
}

async function resolveAppBlockPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  status: AppBlockerStatus;
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
    "Return TOON only with exactly these fields:",
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
    "Return TOON only.",
    formatPromptSection("Current request", currentMessage),
    formatPromptSection("Recent conversation", recentConversation),
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-app-block-planner" },
      () =>
        args.runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseToonKeyValue<Record<string, unknown>>(rawResponse);
    if (!parsed) {
      return { packageNames: [], shouldAct: null };
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
        src: "action:owner-app-block",
        error: error instanceof Error ? error.message : String(error),
      },
      "App blocker planning model call failed",
    );
    return { packageNames: [], shouldAct: null };
  }
}

async function handleBlock(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: AppBlockParams,
): Promise<ActionResult> {
  const status = await getAppBlockerStatus();
  if (!status.available) {
    return {
      success: false,
      text: status.reason ?? "App blocking is not available on this device.",
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

  const explicitPackageNames = normalizePackageNames(params.packageNames);
  const appTokens = normalizeAppTokens(params.appTokens);
  const explicitDurationMinutes = normalizeDurationMinutes(
    params.durationMinutes,
  );

  let installedApps: InstalledAppEntry[] = [];
  if (status.platform === "android") {
    try {
      installedApps = await getInstalledApps();
    } catch (error) {
      runtime.logger?.warn?.(
        {
          src: "action:owner-app-block",
          error: error instanceof Error ? error.message : String(error),
        },
        "App blocker installed-app lookup failed",
      );
    }
  }

  // Fall back to LLM-driven planning when the planner did not supply an
  // explicit selection — vague intents like "block social media" need to be
  // resolved against the device's actual installed-app inventory.
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
      success: false,
      text:
        llmPlan.response ??
        (status.platform === "ios"
          ? "Select the iPhone apps in the mobile app picker first, then I can start the block."
          : "Tell me which installed apps to block so I can match them exactly on your device."),
      values: { success: false, error: "PLANNER_SHOULDACT_FALSE", noop: true },
      data: { noop: true, error: "PLANNER_SHOULDACT_FALSE" },
    };
  }

  const packageNames =
    explicitPackageNames.length > 0
      ? explicitPackageNames
      : (llmPlan?.packageNames ?? []);
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
          : "I couldn't determine which installed apps to block on this device. Name the apps clearly so I can match them against the device inventory."),
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
}

async function handleUnblock(): Promise<ActionResult> {
  const status = await getAppBlockerStatus();
  if (!status.active) {
    return { success: true, text: "No app block is active right now." };
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
}

async function handleStatus(): Promise<ActionResult> {
  const status = await getAppBlockerStatus();
  if (!status.available) {
    return {
      success: false,
      text: status.reason ?? "App blocking is not available on this device.",
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
}

export const ownerAppBlockAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: ["APP_BLOCKER", "SHIELD_APPS", "FAMILY_CONTROLS", "PHONE_FOCUS"],
  description:
    "Owner-only. Manage native phone app blocking via Family Controls (iPhone) or Usage Access (Android). " +
    "Subactions: block (start a block on selected apps for a duration; LLM-extracts apps from intent if not provided), " +
    "unblock (remove the active app block), " +
    "status (check whether a block is active and when it ends). " +
    "Use this ONLY for apps on the owner's phone. Do NOT use it for desktop website blocking — that belongs to OWNER_WEBSITE_BLOCK. " +
    "Do NOT use it for screen-time analytics (OWNER_SCREEN_TIME) or remote desktop sessions (OWNER_REMOTE_DESKTOP).",
  descriptionCompressed:
    "phone app block native iOS-Family-Controls Android-Usage-Access: block(apps,duration) unblock status owner",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    return access.allowed;
  },

  parameters: [
    {
      name: "subaction",
      description: "One of: block, unblock, status.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Free-form description of which apps to block and for how long; used by the block subaction when explicit selection is missing.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "packageNames",
      description:
        "Android package names to block, e.g. ['com.twitter.android']. Used by block on Android.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "appTokens",
      description:
        "iPhone app tokens from a previous selectApps() call. Used by block on iOS.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
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
        content: {
          text: "Block Twitter and Instagram on my phone for 2 hours.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started blocking 2 apps until the block expires.",
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Unblock my phone apps." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Removed the app block. All apps are unblocked now.",
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Is there an app block running?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "An app block is active for 3 apps until 2026-04-15T15:00:00.000Z.",
          action: ACTION_NAME,
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    const access = await getAppBlockerAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? APP_BLOCKER_ACCESS_ERROR,
      };
    }

    const resolved = await resolveActionArgs<AppBlockSubaction, AppBlockParams>(
      {
        runtime,
        message,
        state,
        options,
        actionName: ACTION_NAME,
        subactions: SUBACTIONS,
      },
    );
    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        data: { actionName: ACTION_NAME, missing: resolved.missing },
      };
    }

    const { subaction, params } = resolved;
    switch (subaction) {
      case "block":
        return handleBlock(runtime, message, state, params);
      case "unblock":
        return handleUnblock();
      case "status":
        return handleStatus();
    }
  },
};
