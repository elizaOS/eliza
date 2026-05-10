import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import {
  getSelfControlAccess,
  SELFCONTROL_ACCESS_ERROR,
} from "../website-blocker/access.js";
import {
  BlockRuleReader,
  BlockRuleWriter,
} from "../website-blocker/chat-integration/block-rule-service.js";
import { hasActiveHarshNoBypassRule } from "../website-blocker/chat-integration/harsh-mode-check.js";
import {
  formatWebsiteList,
  type getSelfControlPermissionState,
  getSelfControlStatus,
  normalizeWebsiteTargets,
  parseSelfControlBlockRequest,
  requestSelfControlPermission,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../website-blocker/engine.js";
import { syncWebsiteBlockerExpiryTask } from "../website-blocker/service.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";

const ACTION_NAME = "WEBSITE_BLOCK";

type WebsiteBlockSubaction =
  | "block"
  | "unblock"
  | "status"
  | "request_permission"
  | "release"
  | "list_active";

interface WebsiteBlockParams {
  intent?: string;
  hostnames?: string[] | string;
  durationMinutes?: number | string | null;
  confirmed?: boolean | string | null;
  ruleId?: string | null;
  reason?: string | null;
  includeLiveStatus?: boolean | string | null;
  includeManagedRules?: boolean | string | null;
}

const SUBACTIONS: SubactionsMap<WebsiteBlockSubaction> = {
  block: {
    description:
      "Start a hosts-file block on a set of public hostnames for a fixed duration or indefinitely. Always drafts first; requires confirmed:true to actually edit the hosts file. Heuristic and LLM extract hosts from intent.",
    descriptionCompressed:
      "hosts-file block hostnames duration draft-confirm heuristic+LLM extract-hosts",
    required: ["intent"],
    optional: ["hostnames", "durationMinutes", "confirmed"],
  },
  unblock: {
    description:
      "Clear the active hosts-file block and restore the entries Eliza added. Blocked when a harsh-no-bypass rule is set.",
    descriptionCompressed:
      "clear hosts-file block restore entries blocked-if-harsh-no-bypass",
    required: [],
  },
  status: {
    description:
      "Check whether a hosts-file website block is currently active and when it ends.",
    descriptionCompressed: "hosts-block active+endsAt",
    required: [],
  },
  request_permission: {
    description:
      "Request administrator/root approval for hosts-file edits, or explain the manual change needed when the OS does not support an elevation prompt.",
    descriptionCompressed:
      "request admin/root approval hosts-edits | explain manual-change",
    required: [],
  },
  release: {
    description:
      "Release a managed website block rule by id. Requires confirmed:true. harsh_no_bypass rules cannot be released through this path — they must wait for gate fulfillment.",
    descriptionCompressed:
      "release managed-block-rule(id) confirmed-true; harsh_no_bypass not releasable",
    required: ["ruleId", "confirmed"],
    optional: ["reason"],
  },
  list_active: {
    description:
      "Report the current website blocker state by combining the live OS-level hosts/SelfControl status with LifeOps-managed block rules (id, gateType, websites, gate target). Toggle either source via includeLiveStatus and includeManagedRules.",
    descriptionCompressed:
      "list-active-blocks: live hosts/SelfControl status + managed rules (gateType, target, websites)",
    required: [],
    optional: ["includeLiveStatus", "includeManagedRules"],
  },
};

// ── Block-subaction helpers (moved from website-blocker.ts) ──

type WebsiteBlockPlan = {
  shouldAct?: boolean | null;
  confirmed?: boolean | null;
  response?: string;
  websites: string[];
  durationMinutes?: number | null;
};

type WebsiteBlockConversationTurn = {
  speaker: "user" | "assistant";
  text: string;
};

function coerceConfirmedFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  return false;
}

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function memoryLikeToConversationTurn(
  value: unknown,
  agentId: string,
): WebsiteBlockConversationTurn | null {
  const memory = asRecord(value);
  const content = asRecord(memory?.content);
  const text = typeof content?.text === "string" ? content.text.trim() : "";
  if (!text) return null;
  return {
    speaker: memory?.entityId === agentId ? "assistant" : "user",
    text,
  };
}

function collectProviderBackedConversationTurns(args: {
  state: State | undefined;
  agentId: string;
  limit: number;
}): WebsiteBlockConversationTurn[] {
  const providers = asRecord(asRecord(args.state?.data)?.providers);
  const recentMessagesProvider = asRecord(providers?.RECENT_MESSAGES);
  const recentMessages = asRecord(recentMessagesProvider?.data)?.recentMessages;
  if (!Array.isArray(recentMessages)) return [];
  return recentMessages
    .map((memory) => memoryLikeToConversationTurn(memory, args.agentId))
    .filter(
      (turn): turn is WebsiteBlockConversationTurn =>
        turn !== null && turn.text.length > 0,
    )
    .slice(-args.limit);
}

function normalizeWebsiteCandidates(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.slice(0, 10_000).split(/\s{0,256}\|\|\s{0,256}|,|\n/)
      : [];
  return [
    ...new Set(
      values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 1024))
        .map((item) => item.replace(/^[[\]'"]{1,32}|[[\]'"]{1,32}$/g, ""))
        .filter((item) => item.length > 0),
    ),
  ];
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
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return undefined;
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

const WEBSITE_ALIAS_MAP: Readonly<Record<string, readonly string[]>> = {
  twitter: ["x.com", "twitter.com"],
  x: ["x.com", "twitter.com"],
  reddit: ["reddit.com"],
  youtube: ["youtube.com"],
  facebook: ["facebook.com"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
} as const;

const SOCIAL_MEDIA_SITES = [
  "facebook.com",
  "instagram.com",
  "reddit.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
] as const;

function extractHostsFromIntent(text: string): string[] {
  const normalized = text.toLowerCase();
  const fromAliases = Object.entries(WEBSITE_ALIAS_MAP).flatMap(
    ([alias, websites]) => {
      if (
        !new RegExp(`(^|[^a-z0-9])${alias}([^a-z0-9]|$)`, "i").test(normalized)
      ) {
        return [];
      }
      return [...websites];
    },
  );

  const explicitHosts = Array.from(
    normalized.matchAll(
      /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/g,
    ),
    (match) => match[1] ?? "",
  );

  if (/\bsocial media\b/i.test(normalized)) {
    return normalizeWebsiteCandidates([
      ...explicitHosts,
      ...fromAliases,
      ...SOCIAL_MEDIA_SITES,
    ]);
  }

  return normalizeWebsiteCandidates([...explicitHosts, ...fromAliases]);
}

function extractHeuristicDurationMinutes(
  text: string,
): number | null | undefined {
  const normalized = text.toLowerCase();
  if (
    /\buntil (?:i|we) unblock\b/.test(normalized) ||
    /\buntil manual(?:ly)? removed?\b/.test(normalized) ||
    /\bforever\b/.test(normalized)
  ) {
    return null;
  }

  const hourMatch = normalized.match(/\b(\d+(?:\.\d+)?)\s*hours?\b/);
  if (hourMatch?.[1]) {
    return Math.round(Number.parseFloat(hourMatch[1]) * 60);
  }

  const minuteMatch = normalized.match(/\b(\d+(?:\.\d+)?)\s*minutes?\b/);
  if (minuteMatch?.[1]) {
    return Math.round(Number.parseFloat(minuteMatch[1]));
  }

  return undefined;
}

function shouldTrustExplicitWebsites(
  explicitWebsites: readonly string[],
  heuristicWebsites: readonly string[],
): boolean {
  if (explicitWebsites.length === 0) return false;
  if (heuristicWebsites.length === 0) return true;
  return explicitWebsites.every((website) =>
    heuristicWebsites.includes(website),
  );
}

async function collectWebsiteBlockConversationTurns(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  limit: number;
}): Promise<WebsiteBlockConversationTurn[]> {
  const roomId =
    typeof args.message.roomId === "string" ? args.message.roomId : "";
  if (!roomId || typeof args.runtime.getMemories !== "function") {
    return collectProviderBackedConversationTurns({
      state: args.state,
      agentId: String(args.runtime.agentId),
      limit: args.limit,
    });
  }

  try {
    const memories = await args.runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: Math.max(args.limit * 2, args.limit),
    });
    if (!Array.isArray(memories)) return [];

    return memories
      .slice()
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
      .map((memory) => {
        const text =
          typeof memory?.content?.text === "string"
            ? memory.content.text.trim()
            : "";
        if (!text) return null;
        return {
          speaker:
            memory.entityId === args.runtime.agentId ? "assistant" : "user",
          text,
        } satisfies WebsiteBlockConversationTurn;
      })
      .filter(
        (turn): turn is WebsiteBlockConversationTurn =>
          turn !== null && turn.text.length > 0,
      )
      .slice(-args.limit);
  } catch {
    return collectProviderBackedConversationTurns({
      state: args.state,
      agentId: String(args.runtime.agentId),
      limit: args.limit,
    });
  }
}

async function resolveWebsiteBlockPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<WebsiteBlockPlan> {
  const recentTurns = await collectWebsiteBlockConversationTurns({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 10,
  });
  const currentMessage = getMessageText(args.message).trim();
  const prompt = [
    "Plan the website blocking action for this request.",
    "Use the current request plus recent conversation context.",
    "Return JSON only as a single object with these fields:",
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
    "- If the user says not yet, later, hold off, wait, or is only discussing candidate sites, set shouldAct=false and explain that you will wait for confirmation.",
    "- If the current request refers to previously mentioned websites, recover them from recent conversation context.",
    "- If the websites are unclear or missing, set shouldAct=false and ask the user to name the public hostnames explicitly.",
    "- Prefer bare public hostnames like x.com in the websites array.",
    "- If the user does not give a duration, omit durationMinutes so the block stays active until manually removed.",
    "- Use durationMinutes=null when the user explicitly wants the block to last until manual removal.",
    "- If the user gives an exact timed duration like 45, 90, or 135 minutes, preserve that exact duration.",
    "",
    'Return JSON only, for example {"shouldAct":true,"confirmed":true,"response":null,"websites":["x.com"],"durationMinutes":60}.',
    "Current request:",
    currentMessage || "(empty)",
    "Recent conversation turns:",
    recentTurns.map((t) => `${t.speaker}: ${t.text}`).join("\n") || "(none)",
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-website-block-planner" },
      () =>
        args.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
        }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseJsonModelRecord<Record<string, unknown>>(rawResponse);
    if (!parsed) {
      return { websites: [], shouldAct: null };
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
        src: "action:website-block",
        error: error instanceof Error ? error.message : String(error),
      },
      "Website blocker planning model call failed",
    );
    return { websites: [], shouldAct: null };
  }
}

async function recoverWebsiteContextWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<string[]> {
  const recentTurns = await collectWebsiteBlockConversationTurns({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 12,
  });

  if (recentTurns.length === 0) return [];

  const currentMessage = getMessageText(args.message).trim();
  const prompt = [
    "Recover previously mentioned public website hostnames for a website-block request.",
    "Use the current request plus recent conversation context.",
    'Return JSON only as {"websites":["example.com"]}.',
    "  websites: array of public website hostnames or URLs relevant to the current blocking request",
    "",
    "Rules:",
    "- Extract only websites that were actually mentioned in recent conversation.",
    "- Prefer bare public hostnames like x.com.",
    "- Do not invent websites.",
    "- Return an empty array when no websites were previously mentioned.",
    "",
    "Return JSON only.",
    "Current request:",
    currentMessage || "(empty)",
    "Recent conversation turns:",
    recentTurns.map((t) => `${t.speaker}: ${t.text}`).join("\n") || "(none)",
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-website-block-recovery" },
      () =>
        args.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
        }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseJsonModelRecord<Record<string, unknown>>(rawResponse);
    return normalizeWebsiteCandidates(parsed?.websites);
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:website-block",
        error: error instanceof Error ? error.message : String(error),
      },
      "Website blocker context recovery model call failed",
    );
    return [];
  }
}

// ── Status / Permission formatting ──

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

// ── Subaction handlers ──

async function handleBlock(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: WebsiteBlockParams,
): Promise<ActionResult> {
  const messageText = getMessageText(message);
  const explicitWebsites = normalizeWebsiteTargets(
    normalizeWebsiteCandidates(params.hostnames),
  );
  const explicitDurationMinutes = normalizeDurationMinutes(
    params.durationMinutes,
  );
  const heuristicWebsites = normalizeWebsiteTargets(
    extractHostsFromIntent(messageText),
  );
  const trustedExplicitWebsites = shouldTrustExplicitWebsites(
    explicitWebsites,
    heuristicWebsites,
  )
    ? explicitWebsites
    : [];
  const heuristicDurationMinutes =
    explicitDurationMinutes === undefined
      ? extractHeuristicDurationMinutes(messageText)
      : explicitDurationMinutes;
  const llmPlan =
    trustedExplicitWebsites.length === 0 && heuristicWebsites.length === 0
      ? await resolveWebsiteBlockPlanWithLlm({ runtime, message, state })
      : null;
  const recoveredWebsites =
    trustedExplicitWebsites.length === 0 &&
    (llmPlan?.websites.length ?? 0) === 0
      ? await recoverWebsiteContextWithLlm({ runtime, message, state })
      : [];
  const plannedWebsites =
    trustedExplicitWebsites.length > 0
      ? trustedExplicitWebsites
      : heuristicWebsites.length > 0
        ? heuristicWebsites
        : (((llmPlan?.websites.length ?? 0) > 0
            ? llmPlan?.websites
            : recoveredWebsites) ?? []);

  const plannedWebsitesSafe: readonly string[] = plannedWebsites ?? [];
  if (llmPlan?.shouldAct === false && trustedExplicitWebsites.length === 0) {
    return {
      success: false,
      text:
        llmPlan.response ??
        (plannedWebsitesSafe.length > 0
          ? `I noted ${formatWebsiteList(plannedWebsitesSafe)} and will wait for your confirmation before blocking them.`
          : "I noted those websites and will wait for your confirmation before blocking them."),
      data: {
        deferred: true,
        noop: true,
        websites: [...plannedWebsitesSafe],
      },
    };
  }

  const parsed = parseSelfControlBlockRequest({
    parameters: {
      websites:
        plannedWebsitesSafe.length > 0 ? [...plannedWebsitesSafe] : null,
      durationMinutes:
        explicitDurationMinutes !== undefined
          ? explicitDurationMinutes
          : heuristicDurationMinutes !== undefined
            ? heuristicDurationMinutes
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
    coerceConfirmedFlag(params.confirmed) || llmPlan?.confirmed === true;
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
        requiresConfirmation: true,
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
}

async function handleUnblock(runtime: IAgentRuntime): Promise<ActionResult> {
  if (await hasActiveHarshNoBypassRule(runtime)) {
    return {
      success: false,
      text: "You set a harsh-no-bypass rule for this — clear the rule first via the rule manager. The reconciler would re-create the block on its next tick anyway.",
      data: { refusedByHarshNoBypassRule: true },
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
}

async function handleStatus(): Promise<ActionResult> {
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
}

async function handleRequestPermission(): Promise<ActionResult> {
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
}

// ── release / list_active subactions (W2-F) ──
//
// Folded in from the deleted standalone `RELEASE_BLOCK` and
// `LIST_ACTIVE_BLOCKS` actions, resolving the umbrella collision flagged in
// `HARDCODING_AUDIT.md` §6 high-confidence #6. The block-rule reader/writer
// remain in `website-blocker/chat-integration` — only the `Action` envelopes
// were collapsed.

function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function coerceBooleanFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(normalized)) return true;
    if (["false", "no", "0", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function formatLiveWebsiteBlockStatus(
  status: Awaited<ReturnType<typeof getSelfControlStatus>>,
): string {
  if (!status.available) {
    return (
      status.reason ?? "The live website blocker is unavailable on this machine."
    );
  }
  const permissionNote = status.reason ? ` ${status.reason}` : "";
  if (!status.active) {
    return `No live website block is active right now.${permissionNote}`;
  }
  const websites =
    status.websites.length > 0
      ? formatWebsiteList(status.websites)
      : "an unknown website set";
  return status.endsAt
    ? `A live website block is active for ${websites} until ${status.endsAt}.${permissionNote}`
    : `A live website block is active for ${websites} until you remove it.${permissionNote}`;
}

async function handleRelease(
  runtime: IAgentRuntime,
  params: WebsiteBlockParams,
): Promise<ActionResult> {
  const ruleId = coerceString(params.ruleId);
  if (!ruleId) {
    return {
      success: false,
      text: "WEBSITE_BLOCK release requires a ruleId.",
    };
  }
  if (!coerceConfirmedFlag(params.confirmed)) {
    return {
      success: false,
      text: "WEBSITE_BLOCK release requires confirmed:true to release the rule.",
    };
  }
  const reason = coerceString(params.reason) ?? "user_confirmed";
  const writer = new BlockRuleWriter(runtime);
  try {
    await writer.releaseBlockRule(ruleId, { confirmed: true, reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      text: `Failed to release block rule ${ruleId}: ${message}`,
    };
  }
  return {
    success: true,
    text: `Released block rule ${ruleId}.`,
    data: { ruleId, reason },
  };
}

async function handleListActive(
  runtime: IAgentRuntime,
  params: WebsiteBlockParams,
): Promise<ActionResult> {
  const includeLiveStatus = coerceBooleanFlag(params.includeLiveStatus, true);
  const includeManagedRules = coerceBooleanFlag(
    params.includeManagedRules,
    true,
  );
  const reader = new BlockRuleReader(runtime);
  const [rules, liveStatus] = await Promise.all([
    includeManagedRules ? reader.listActiveBlocks() : Promise.resolve([]),
    includeLiveStatus
      ? getSelfControlStatus()
      : Promise.resolve(
          null as Awaited<ReturnType<typeof getSelfControlStatus>> | null,
        ),
  ]);
  const sections = liveStatus
    ? [formatLiveWebsiteBlockStatus(liveStatus)]
    : [];
  if (!includeManagedRules) {
    return {
      success: true,
      text:
        sections.join("\n") || "Managed block rule listing was not requested.",
      data: {
        actionName: ACTION_NAME,
        rules: [],
        liveStatus,
      },
    };
  }
  if (rules.length === 0) {
    sections.push("No managed website block rules are active.");
    return {
      success: true,
      text: sections.join("\n"),
      data: { actionName: ACTION_NAME, rules: [], liveStatus },
    };
  }
  const summaries = rules.map((rule) => {
    const parts = [
      `${rule.id} (${rule.gateType})`,
      `sites=${rule.websites.join(",")}`,
    ];
    if (rule.gateType === "until_todo" && rule.gateTodoId) {
      parts.push(`todo=${rule.gateTodoId}`);
    }
    if (rule.gateType === "until_iso" && rule.gateUntilMs !== null) {
      parts.push(`until=${new Date(rule.gateUntilMs).toISOString()}`);
    }
    if (rule.gateType === "fixed_duration" && rule.fixedDurationMs !== null) {
      parts.push(`duration_ms=${rule.fixedDurationMs}`);
    }
    return parts.join(" ");
  });
  sections.push(`Managed block rules:\n${summaries.join("\n")}`);
  return {
    success: true,
    text: sections.join("\n"),
    data: { actionName: ACTION_NAME, rules, liveStatus },
  };
}

// ── Action ──

export const websiteBlockAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "SELFCONTROL",
    "SITE_BLOCKER",
    "HOSTS_BLOCK",
    "FOCUS_BLOCK",
    "AUTOMATION_FOCUS_BLOCK",
    "BLOCK_WEBSITE",
    "WEBSITE_BLOCKER",
  ],
  description:
    "Owner-only. Manage local hosts-file website blocking on this Mac. Subactions: block (start a fixed-duration or indefinite block on a set of public hostnames; always drafts first, requires confirmed:true to actually edit the hosts file), unblock (remove the active block), status (check whether a block is active and when it ends), request_permission (request administrator/root approval for hosts-file edits), release (release a managed block rule by id; requires confirmed:true; harsh_no_bypass rules cannot be released this way), list_active (list live OS-level + managed website block rules).",
  descriptionCompressed:
    "site block hosts-file: block(hosts,duration,confirm) unblock status request-permission release(ruleId,confirmed) list_active; macOS draft-then-confirm",
  contexts: ["screen_time", "browser", "automation", "tasks", "settings"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    return access.allowed;
  },

  parameters: [
    {
      name: "subaction",
      description:
        "One of: block, unblock, status, request_permission, release, list_active. When omitted the resolver extracts it from intent + recent conversation.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Free-form description of what the owner wants. Required by the block subaction so heuristic + LLM extractors can pull hostnames and duration out.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "hostnames",
      description:
        "Public hostnames or URLs to block for the block subaction, e.g. ['x.com','twitter.com'].",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "durationMinutes",
      description:
        "How long to block, in minutes. Omit for a manual block that stays active until unblocked. Null for indefinite.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "confirmed",
      description:
        "Set true only when the owner has explicitly confirmed the block. Without it, block returns a draft confirmation request. Also required by the release subaction.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "ruleId",
      description:
        "ID of the managed block rule to release. Required by the release subaction.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description:
        "Optional reason recorded on the rule when released. Used by the release subaction.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "includeLiveStatus",
      description:
        "Whether to include the current hosts-file/SelfControl live block state in the list_active response. Default true.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "includeManagedRules",
      description:
        "Whether to include managed LifeOps block rules in the list_active response. Default true.",
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
          action: "WEBSITE_BLOCK",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Is there a website block running right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "A website block is active for x.com, twitter.com until 2026-04-04T13:44:54.000Z.",
          action: "WEBSITE_BLOCK",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Unblock x.com right now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Removed the website block for x.com before its scheduled end time.",
          action: "WEBSITE_BLOCK",
        },
      },
    ],
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
          text: "The approval prompt completed successfully. Eliza can now ask the OS for administrator approval whenever it needs to edit the hosts file.",
          action: "WEBSITE_BLOCK",
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    _callback,
  ): Promise<ActionResult> => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? SELFCONTROL_ACCESS_ERROR,
      };
    }

    const resolved = await resolveActionArgs<
      WebsiteBlockSubaction,
      WebsiteBlockParams
    >({
      runtime,
      message,
      state,
      options: options as HandlerOptions | undefined,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
    });
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
        return handleUnblock(runtime);
      case "status":
        return handleStatus();
      case "request_permission":
        return handleRequestPermission();
      case "release":
        return handleRelease(runtime, params);
      case "list_active":
        return handleListActive(runtime, params);
    }
  },
};
