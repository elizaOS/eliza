import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { getSelfControlAccess, SELFCONTROL_ACCESS_ERROR } from "../website-blocker/access.ts";
import {
  extractDurationMinutesFromText,
  extractWebsiteTargetsFromText,
  formatWebsiteList,
  getSelfControlPermissionState,
  getSelfControlStatus,
  hasIndefiniteBlockIntent,
  hasWebsiteBlockDeferralIntent,
  parseSelfControlBlockRequest,
  requestSelfControlPermission,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../website-blocker/engine.ts";
import { syncWebsiteBlockerExpiryTask } from "../website-blocker/service.ts";

const WEBSITE_BLOCKER_CONTEXT_WINDOW = 16;

type WebsiteBlockerConversationEntry = {
  entityId: string | null;
  fromCurrentSender: boolean;
  text: string;
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

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hasExplicitBlockParameters(options?: HandlerOptions): boolean {
  const params = options?.parameters as
    | {
        websites?: string[] | string;
        durationMinutes?: number | string | null;
      }
    | undefined;

  return (
    params?.websites !== undefined || params?.durationMinutes !== undefined
  );
}

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function getMemoryTimestamp(memory: Memory): number | null {
  const rawCreatedAt: unknown = (
    memory as Memory & { createdAt?: number | string | Date }
  ).createdAt;

  if (typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt)) {
    return rawCreatedAt;
  }

  if (typeof rawCreatedAt === "string") {
    const parsed = Date.parse(rawCreatedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (rawCreatedAt instanceof Date) {
    return rawCreatedAt.getTime();
  }

  return null;
}

async function collectWebsiteBlockerConversation(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<WebsiteBlockerConversationEntry[]> {
  const recent =
    typeof runtime.getMemories === "function"
      ? await runtime.getMemories({
          tableName: "messages",
          roomId: message.roomId,
          limit: WEBSITE_BLOCKER_CONTEXT_WINDOW,
        })
      : [];

  const seen = new Set<string>();
  return [...recent, message]
    .map((entry, index) => ({
      entry,
      index,
      timestamp: getMemoryTimestamp(entry),
    }))
    .sort((left, right) => {
      if (left.timestamp === null && right.timestamp === null) {
        return left.index - right.index;
      }

      if (left.timestamp === null) {
        return 1;
      }

      if (right.timestamp === null) {
        return -1;
      }

      return left.timestamp - right.timestamp || left.index - right.index;
    })
    .map(({ entry }) => entry)
    .map((entry) => ({
      entityId: typeof entry.entityId === "string" ? entry.entityId : null,
      fromCurrentSender: entry.entityId === message.entityId,
      text:
        typeof entry.content?.text === "string"
          ? normalizeText(entry.content.text)
          : "",
    }))
    .filter((entry) => entry.text.length > 0)
    .filter((entry) => {
      const key = `${entry.entityId ?? "unknown"}:${entry.fromCurrentSender ? "1" : "0"}:${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-WEBSITE_BLOCKER_CONTEXT_WINDOW);
}

function collectConversationWebsites(
  conversation: WebsiteBlockerConversationEntry[],
): string[] {
  const currentSenderWebsites = conversation.flatMap((entry) =>
    entry.fromCurrentSender ? extractWebsiteTargetsFromText(entry.text) : [],
  );
  if (currentSenderWebsites.length > 0) {
    return currentSenderWebsites;
  }

  return conversation.flatMap((entry) =>
    extractWebsiteTargetsFromText(entry.text),
  );
}

function resolveConversationDuration(
  conversation: WebsiteBlockerConversationEntry[],
): number | null | undefined {
  const ordered = [...conversation].reverse();

  for (const entry of ordered) {
    if (!entry.fromCurrentSender) continue;
    if (hasIndefiniteBlockIntent(entry.text)) {
      return null;
    }
    const durationMinutes = extractDurationMinutesFromText(entry.text);
    if (durationMinutes !== null) {
      return durationMinutes;
    }
  }

  for (const entry of ordered) {
    if (hasIndefiniteBlockIntent(entry.text)) {
      return null;
    }
    const durationMinutes = extractDurationMinutesFromText(entry.text);
    if (durationMinutes !== null) {
      return durationMinutes;
    }
  }

  return undefined;
}

async function extractWebsiteBlockRequest(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ReturnType<typeof parseSelfControlBlockRequest>> {
  const conversation = await collectWebsiteBlockerConversation(
    runtime,
    message,
  );
  const websites = collectConversationWebsites(conversation);
  const durationMinutes = resolveConversationDuration(conversation);

  if (websites.length === 0) {
    return {
      request: null,
      error:
        "Could not determine which public website hostnames to block from the recent conversation. Name the sites explicitly, or pass them to the action as parameters.",
    };
  }

  return parseSelfControlBlockRequest({
    parameters: {
      websites,
      durationMinutes,
    },
  } as HandlerOptions);
}

async function resolveWebsiteBlockRequest(
  runtime: IAgentRuntime,
  message: Memory,
  options?: HandlerOptions,
): Promise<ReturnType<typeof parseSelfControlBlockRequest>> {
  if (hasExplicitBlockParameters(options)) {
    return parseSelfControlBlockRequest(options);
  }

  return await extractWebsiteBlockRequest(runtime, message);
}

export const blockWebsitesAction: Action = {
  name: "BLOCK_WEBSITES",
  similes: [
    "SELFCONTROL_BLOCK_WEBSITES",
    "BLOCK_WEBSITE",
    "BLOCK_SITE",
    "BLOCK_WEBSITE_NOW",
    "WEBSITE_BLOCKER",
    "WEBSITEBLOCKER",
    "START_FOCUS_BLOCK",
    "BLOCK_SITE",
    "BLOCK_DISTRACTING_SITES",
  ],
  description:
    "Admin-only. Start a local website block by editing the system hosts file. " +
    "Use recent conversation context to block public websites like x.com for a fixed duration or until manually unblocked. " +
    "If the user confirms a block in a follow-up message without repeating the hostnames, reuse the recent conversation context.",
  descriptionCompressed: "Admin: block websites via hosts file for set duration.",
  validate: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    return (
      access.allowed && !hasWebsiteBlockDeferralIntent(getMessageText(message))
    );
  },
  handler: async (runtime, message, _state, options) => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? SELFCONTROL_ACCESS_ERROR,
      };
    }

    if (hasWebsiteBlockDeferralIntent(getMessageText(message))) {
      return {
        success: true,
        text: "I noted those websites and will wait for your confirmation before blocking them.",
        data: {
          deferred: true,
        },
      };
    }

    const parsed = await resolveWebsiteBlockRequest(runtime, message, options);
    if (!parsed.request) {
      return {
        success: false,
        text: parsed.error ?? "Could not parse the website block request.",
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
        "Website hostnames or URLs to block, for example ['x.com', 'twitter.com']. When omitted, Eliza derives them from the recent conversation context.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "durationMinutes",
      description:
        "How long to block those websites, in minutes. Omit this to use the default duration.",
      required: false,
      schema: { type: "number" as const, default: 60 },
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
          text: "Started a website block for x.com, twitter.com until 2026-04-04T13:44:54.000Z.",
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
    "REQUEST_WEBSITE_BLOCKING_PERMISSION",
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
    "UNBLOCK_WEBSITES",
    "REMOVE_WEBSITE_BLOCK",
    "STOP_BLOCKING_SITES",
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
