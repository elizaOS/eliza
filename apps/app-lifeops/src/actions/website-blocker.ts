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
  getSelfControlAccess,
  SELFCONTROL_ACCESS_ERROR,
} from "../website-blocker/access.ts";
import {
  formatWebsiteList,
  type getSelfControlPermissionState,
  getSelfControlStatus,
  parseSelfControlBlockRequest,
  requestSelfControlPermission,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../website-blocker/engine.ts";
import { syncWebsiteBlockerExpiryTask } from "../website-blocker/service.ts";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";

type BlockWebsitesParameters = {
  websites?: string[] | string;
  durationMinutes?: number | string | null;
  confirmed?: boolean | string | null;
};

function coerceConfirmedFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  return false;
}

type WebsiteBlockPlan = {
  shouldAct?: boolean | null;
  confirmed?: boolean | null;
  response?: string;
  websites: string[];
  durationMinutes?: number | null;
};

function formatStatusText(
  status: Awaited<ReturnType<typeof getSelfControlStatus>>,
): string {
  if (!status.available) {
    return (
      status.reason ?? "Local website blocking is unavailable on this machine."
    );
  }

  const permissionNote = status.reason ? ` ${status.reason}` : "";

  if (!status.active) {
    return `No website block is active right now.${permissionNote}`;
  }

  const websites =
    status.websites.length > 0
      ? formatWebsiteList(status.websites)
      : "an unknown website set";
  return status.endsAt
    ? `A website block is active for ${websites} until ${status.endsAt}.${permissionNote}`
    : `A website block is active for ${websites} until you remove it.${permissionNote}`;
}

function formatPermissionText(
  permission: Awaited<ReturnType<typeof getSelfControlPermissionState>>,
): string {
  if (permission.status === "granted") {
    return (
      permission.reason ??
      "Website blocking permission is ready. Eliza can edit the system hosts file directly on this machine."
    );
  }

  if (permission.canRequest) {
    return (
      permission.reason ??
      "Eliza can ask the OS for administrator/root approval whenever it needs to edit the system hosts file."
    );
  }

  return (
    permission.reason ??
    "Eliza cannot raise an administrator/root prompt for website blocking on this machine."
  );
}

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

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function normalizeWebsiteCandidates(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s*\|\|\s*|,|\n/)
      : [];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
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

async function resolveWebsiteBlockPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<WebsiteBlockPlan> {
  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 8,
    })
  ).join("\n");
  const currentMessage = getMessageText(args.message).trim();
  const prompt = [
    "Plan the website blocking action for this request.",
    "Use the current request plus recent conversation context.",
    "Return a JSON object with these fields:",
    "  shouldAct: boolean",
    "  confirmed: boolean",
    "  response: short natural-language reply when clarification or deferral is needed",
    "  websites: array of public website hostnames or URLs to block",
    "  durationMinutes: positive integer for a timed block, or null/omit for an indefinite/manual block",
    "",
    "Rules:",
    "- Only start a block when the user is clearly asking to block websites now.",
    "- Set confirmed=true only when the current request explicitly authorizes the block to happen now, including a direct follow-up instruction to act now on previously discussed websites.",
    "- Set confirmed=false when the user is only naming candidate websites, asking for advice, or asking you to wait.",
    "- Generic focus-block requests like 'turn on a focus block for all social media sites' belong here; do not invent a task gate for them.",
    "- Use BLOCK_WEBSITES for fixed-duration or generic focus blocks. Do not treat them as task-gated blocks unless the user explicitly says until I finish, until I complete, or until I'm done with a task.",
    "- If the user says not yet, later, hold off, wait, or is only discussing candidate sites, set shouldAct=false and explain that you will wait for confirmation.",
    "- If the current request refers to previously mentioned websites, recover them from recent conversation context.",
    "- If the websites are unclear or missing, set shouldAct=false and ask the user to name the public hostnames explicitly.",
    "- Prefer bare public hostnames like x.com in the websites array.",
    "- If the user does not give a duration, omit durationMinutes so the block stays active until manually removed.",
    "- Use durationMinutes=null when the user explicitly wants the block to last until manual removal.",
    "- If the user gives an exact timed duration like 45, 90, or 135 minutes, preserve that exact duration.",
    "",
    "Examples:",
    '  {"shouldAct":true,"confirmed":true,"response":null,"websites":["x.com","twitter.com"],"durationMinutes":120}',
    '  {"shouldAct":true,"confirmed":true,"response":null,"websites":["twitter.com"],"durationMinutes":90}',
    '  {"shouldAct":false,"confirmed":false,"response":"I noted those websites and will wait for your confirmation before blocking them.","websites":["x.com","twitter.com"]}',
    '  {"shouldAct":false,"confirmed":false,"response":"Tell me which public website hostnames to block, such as x.com or youtube.com.","websites":[]}',
    '  {"shouldAct":true,"confirmed":true,"response":null,"websites":["x.com","twitter.com"],"durationMinutes":1}',
    "",
    "Return ONLY valid JSON.",
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: runtime.useModel is an async service call, not a React hook.
    const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
      parseJSONObjectFromText(rawResponse);
    if (!parsed) {
      return {
        websites: [],
        shouldAct: null,
      };
    }
    return {
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      confirmed: normalizeShouldAct(parsed.confirmed),
      response: normalizePlannerResponse(parsed.response),
      websites: normalizeWebsiteCandidates(parsed.websites),
      durationMinutes: normalizeDurationMinutes(parsed.durationMinutes),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:website-blocker",
        error: error instanceof Error ? error.message : String(error),
      },
      "Website blocker planning model call failed",
    );
    return {
      websites: [],
      shouldAct: null,
    };
  }
}

export const blockWebsitesAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "BLOCK_WEBSITES",
  similes: [
    "SELFCONTROL_BLOCK_WEBSITES",
    "BLOCK_WEBSITE",
    "BLOCK_SITE",
    "BLOCK_WEBSITE_NOW",
    "WEBSITE_BLOCKER",
    "WEBSITEBLOCKER",
    "START_FOCUS_BLOCK",
    "BLOCK_DISTRACTING_SITES",
  ],
  description:
    "Admin-only. Start a local website block by editing the system hosts file. " +
    "Use this for fixed-duration or generic focus blocks like 'block twitter and reddit for the next 2 hours', 'turn on a focus block for all social media sites', or 'block youtube'. " +
    "Use recent conversation context to block public websites like x.com for a fixed duration or until manually unblocked. " +
    "Do not use this when the unblock condition is finishing a task, workout, or todo; that is BLOCK_UNTIL_TASK_COMPLETE. " +
    "Always drafts first; the owner must pass confirmed: true (e.g. by replying 'confirm') to actually edit the hosts file. " +
    "If the user confirms a block in a follow-up message without repeating the hostnames, reuse that context through the action planner." +
    " DO NOT use this action when the user references apps, games, or things 'on my phone' / 'on my device' — use BLOCK_APPS for those. Do not pair this action with a speculative REPLY; this action provides the final reply itself.",
  descriptionCompressed:
    "Admin: block websites via hosts file for set duration.",
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message, state, options) => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? SELFCONTROL_ACCESS_ERROR,
      };
    }

    const params = options?.parameters as BlockWebsitesParameters | undefined;
    const explicitWebsites = normalizeWebsiteCandidates(params?.websites);
    const explicitDurationMinutes = normalizeDurationMinutes(
      params?.durationMinutes,
    );
    const llmPlan =
      explicitWebsites.length === 0
        ? await resolveWebsiteBlockPlanWithLlm({
            runtime,
            message,
            state,
          })
        : null;

    if (llmPlan?.shouldAct === false && explicitWebsites.length === 0) {
      return {
        success: true,
        text:
          llmPlan.response ??
          "I noted those websites and will wait for your confirmation before blocking them.",
        data: {
          deferred: true,
          noop: true,
        },
      };
    }

    const parsed = parseSelfControlBlockRequest({
      parameters: {
        websites:
          explicitWebsites.length > 0
            ? explicitWebsites
            : (llmPlan?.websites ?? null),
        durationMinutes:
          explicitDurationMinutes !== undefined
            ? explicitDurationMinutes
            : (llmPlan?.durationMinutes ?? null),
      },
    });
    if (!parsed.request) {
      return {
        success: false,
        text:
          llmPlan?.response ??
          parsed.error ??
          "Could not determine which public website hostnames to block.",
      };
    }

    const confirmed =
      coerceConfirmedFlag(params?.confirmed) || llmPlan?.confirmed === true;
    if (!confirmed) {
      const websitesLabel = formatWebsiteList(parsed.request.websites);
      const durationLabel =
        parsed.request.durationMinutes === null
          ? "until you manually unblock"
          : `for ${parsed.request.durationMinutes} minute${parsed.request.durationMinutes === 1 ? "" : "s"}`;
      return {
        success: true,
        text: `Ready to block ${websitesLabel} ${durationLabel}. Reply "confirm" or re-issue with confirmed: true to start the block.`,
        data: {
          draft: true,
          websites: parsed.request.websites,
          durationMinutes: parsed.request.durationMinutes,
        },
      };
    }

    const result = await startSelfControlBlock({
      ...parsed.request,
      scheduledByAgentId: String(runtime.agentId),
    });
    if (result.success === false) {
      return {
        success: false,
        text: result.error,
        data: result.status
          ? {
              active: result.status.active,
              endsAt: result.status.endsAt,
              websites: result.status.websites,
              requiresElevation: result.status.requiresElevation,
            }
          : undefined,
      };
    }

    if (parsed.request.durationMinutes !== null) {
      try {
        const taskId = await syncWebsiteBlockerExpiryTask(runtime);
        if (!taskId) {
          await stopSelfControlBlock();
          return {
            success: false,
            text: "Eliza started the website block but could not schedule its automatic unblock task, so it rolled the block back.",
          };
        }
      } catch (error) {
        await stopSelfControlBlock();
        return {
          success: false,
          text: `Eliza could not schedule the automatic unblock task, so it rolled the website block back. ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    return {
      success: true,
      text:
        result.endsAt === null
          ? `Started a website block for ${formatWebsiteList(parsed.request.websites)} until you unblock it.`
          : `Started a website block for ${formatWebsiteList(parsed.request.websites)} until ${result.endsAt}.`,
      data: {
        websites: parsed.request.websites,
        durationMinutes: parsed.request.durationMinutes,
        endsAt: result.endsAt,
      },
    };
  },
  parameters: [
    {
      name: "websites",
      description:
        "Website hostnames or URLs to block, for example ['x.com', 'twitter.com']. When omitted, the planner can recover them from recent conversation context.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "durationMinutes",
      description:
        "How long to block those websites, in minutes. Omit this for a manual block that stays active until unblocked.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "confirmed",
      description:
        "Set to true only when the owner has explicitly confirmed the block. Without it, the action returns a draft confirmation request instead of editing the system hosts file.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Block x.com and twitter.com for 2 hours." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Ready to block x.com, twitter.com for 120 minutes. Reply "confirm" or re-issue with confirmed: true to start the block.',
          action: "BLOCK_WEBSITES",
        },
      },
      {
        name: "{{name1}}",
        content: { text: "confirm" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started a website block for x.com, twitter.com until 2026-04-04T13:44:54.000Z.",
          action: "BLOCK_WEBSITES",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Block twitter.com for exactly 90 minutes." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started a website block for twitter.com until 2026-04-04T13:44:54.000Z.",
          action: "BLOCK_WEBSITES",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Turn on a focus block for all social media sites.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started a website block for facebook.com, instagram.com, reddit.com, tiktok.com, x.com, and youtube.com until you unblock it.",
          action: "BLOCK_WEBSITES",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "The websites distracting me are x.com and twitter.com. Do not block them yet.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I noted those websites and will wait for your confirmation before blocking them.",
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "Use self control now. Actually block the websites for 1 minute instead of giving advice.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started a website block for x.com, twitter.com until 2026-04-04T13:44:54.000Z.",
          action: "BLOCK_WEBSITES",
        },
      },
    ],
  ] as ActionExample[][],
};

export const getWebsiteBlockStatusAction: Action = {
  name: "GET_WEBSITE_BLOCK_STATUS",
  similes: [
    "SELFCONTROL_GET_BLOCK_STATUS",
    "CHECK_WEBSITE_BLOCK_STATUS",
    "CHECK_SELFCONTROL",
    "IS_BLOCK_RUNNING",
  ],
  description:
    "Admin-only. Check whether a local hosts-file website block is currently active and when it ends.",
  descriptionCompressed: "Admin: check website block status.",
  validate: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? SELFCONTROL_ACCESS_ERROR,
      };
    }

    const status = await getSelfControlStatus();
    return {
      success: status.available,
      text: formatStatusText(status),
      data: {
        available: status.available,
        active: status.active,
        endsAt: status.endsAt,
        websites: status.websites,
        requiresElevation: status.requiresElevation,
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
        content: { text: "Is there a website block running right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "A website block is active for x.com, twitter.com until 2026-04-04T13:44:54.000Z.",
          action: "GET_WEBSITE_BLOCK_STATUS",
        },
      },
    ],
  ] as ActionExample[][],
};

export const requestWebsiteBlockingPermissionAction: Action = {
  name: "REQUEST_WEBSITE_BLOCKING_PERMISSION",
  similes: [
    "ENABLE_WEBSITE_BLOCKING",
    "ALLOW_WEBSITE_BLOCKING",
    "GRANT_WEBSITE_BLOCKING_PERMISSION",
    "REQUEST_SELFCONTROL_PERMISSION",
  ],
  description:
    "Admin-only. Prepare local website blocking by requesting administrator/root approval when the machine supports it, or explain the manual change needed when it does not.",
  descriptionCompressed: "Admin: request website blocking permission.",
  validate: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? SELFCONTROL_ACCESS_ERROR,
      };
    }

    const permission = await requestSelfControlPermission();
    const success =
      permission.status === "granted" || permission.promptSucceeded === true;

    return {
      success,
      text: formatPermissionText(permission),
      data: {
        status: permission.status,
        canRequest: permission.canRequest,
        reason: permission.reason,
        hostsFilePath: permission.hostsFilePath,
        supportsElevationPrompt: permission.supportsElevationPrompt,
        elevationPromptMethod: permission.elevationPromptMethod,
        promptAttempted: permission.promptAttempted,
        promptSucceeded: permission.promptSucceeded,
      },
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Give yourself permission to block websites on this machine.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "The approval prompt completed successfully. Eliza can ask the OS for administrator/root approval whenever it needs to edit the system hosts file. That approval is per operation, so you may see the prompt again when starting or stopping a block.",
          action: "REQUEST_WEBSITE_BLOCKING_PERMISSION",
        },
      },
    ],
  ] as ActionExample[][],
};

export const unblockWebsitesAction: Action = {
  name: "UNBLOCK_WEBSITES",
  similes: [
    "SELFCONTROL_UNBLOCK_WEBSITES",
    "REMOVE_WEBSITE_BLOCK",
    "STOP_BLOCKING_SITES",
    "LIFT_WEBSITE_BLOCK",
  ],
  description:
    "Admin-only. Remove the current local website block by restoring the system hosts file entries Eliza added.",
  descriptionCompressed: "Admin: remove website block.",
  validate: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    return access.allowed;
  },
  handler: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? SELFCONTROL_ACCESS_ERROR,
      };
    }

    const status = await getSelfControlStatus();
    if (!status.available) {
      return {
        success: false,
        text:
          status.reason ??
          "Local website blocking is unavailable on this machine, so there is nothing to unblock.",
      };
    }

    if (!status.active) {
      return {
        success: true,
        text: "No website block is active right now.",
        data: {
          active: false,
          canUnblockEarly: false,
          requiresElevation: status.requiresElevation,
        },
      };
    }

    const result = await stopSelfControlBlock();
    if (result.success === false) {
      return {
        success: false,
        text: result.error,
        data: result.status
          ? {
              active: result.status.active,
              canUnblockEarly: result.status.canUnblockEarly,
              endsAt: result.status.endsAt,
              websites: result.status.websites,
              requiresElevation: result.status.requiresElevation,
            }
          : undefined,
      };
    }

    return {
      success: true,
      text:
        status.endsAt === null
          ? `Removed the website block for ${formatWebsiteList(status.websites)}.`
          : `Removed the website block for ${formatWebsiteList(status.websites)} before its scheduled end time.`,
      data: {
        active: false,
        canUnblockEarly: true,
        endsAt: null,
        websites: status.websites,
      },
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Unblock x.com right now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Removed the website block for x.com before its scheduled end time.",
          action: "UNBLOCK_WEBSITES",
        },
      },
    ],
  ] as ActionExample[][],
};

export const selfControlBlockWebsitesAction = blockWebsitesAction;
export const selfControlGetStatusAction = getWebsiteBlockStatusAction;
export const selfControlRequestPermissionAction =
  requestWebsiteBlockingPermissionAction;
export const selfControlUnblockWebsitesAction = unblockWebsitesAction;
