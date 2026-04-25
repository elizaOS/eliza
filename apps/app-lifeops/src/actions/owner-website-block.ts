/**
 * OWNER_WEBSITE_BLOCK — Tier 2-D umbrella.
 *
 * Collapses local hosts-file website blocking (block / unblock / status /
 * request_permission) into a single owner-only action dispatched by a required
 * `subaction` parameter. Routes to the existing handlers in website-blocker.ts.
 */

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
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import {
  getSelfControlAccess,
  SELFCONTROL_ACCESS_ERROR,
} from "../website-blocker/access.ts";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";
import {
  blockWebsitesAction,
  getWebsiteBlockStatusAction,
  requestWebsiteBlockingPermissionAction,
  unblockWebsitesAction,
} from "./website-blocker.js";

const ACTION_NAME = "OWNER_WEBSITE_BLOCK";

type Subaction = "block" | "unblock" | "status" | "request_permission";

interface OwnerWebsiteBlockParameters {
  subaction?: Subaction | string;
  websites?: string[] | string;
  durationMinutes?: number | string | null;
  confirmed?: boolean | string | null;
  intent?: string;
}

const HOSTNAME_ONLY_RE =
  /^(?:(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)(?:\s*(?:,|and)\s*(?:(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?))*$/i;

const DIRECT_CONFIRMATION_RE =
  /^(?:yes|yep|yeah|sure|ok|okay|please do|do it|do it now|actually do it now|go ahead|confirm|confirmed)\b/i;

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function messageLooksLikeHostnameOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && HOSTNAME_ONLY_RE.test(trimmed);
}

function parseDirectJsonObject(
  rawResponse: string,
): Record<string, unknown> | null {
  try {
    const directJson = JSON.parse(rawResponse);
    return directJson &&
      typeof directJson === "object" &&
      !Array.isArray(directJson)
      ? (directJson as Record<string, unknown>)
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isPermissionRequest(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    /(pre[- ]?approve|preapprove|permission|approval|administrator|admin|root|startup)/.test(
      normalized,
    ) && /(website|site|block|blocking|hosts file)/.test(normalized)
  );
}

function isStatusRequest(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    /(what sites|which sites|what websites|which websites|status|running|active|currently blocked|blocked right now|when .* end|when .* expire)/.test(
      normalized,
    ) && /(website|site|block|blocking)/.test(normalized)
  );
}

function isUnblockRequest(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    /(unblock|remove|lift|stop|end|turn off|disable)/.test(normalized) &&
    /(website|site|block|blocking|x\.com|twitter\.com|instagram\.com|youtube\.com|reddit\.com|facebook\.com|tiktok\.com|\b[a-z0-9-]+\.[a-z0-9.-]+\b)/.test(
      normalized,
    )
  );
}

function isBlockRequest(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    /\bblock(?:ing|ed)?\b/.test(normalized) &&
    !/\bunblock\b/.test(normalized) &&
    /(website|site|x\.com|twitter\.com|instagram\.com|youtube\.com|reddit\.com|facebook\.com|tiktok\.com|\b[a-z0-9-]+\.[a-z0-9.-]+\b)/.test(
      normalized,
    )
  );
}

function inferRecentSubaction(
  currentText: string,
  recentConversationLines: readonly string[],
): Subaction | null {
  if (isPermissionRequest(currentText)) {
    return "request_permission";
  }
  if (isStatusRequest(currentText)) {
    return "status";
  }
  if (isUnblockRequest(currentText)) {
    return "unblock";
  }
  if (isBlockRequest(currentText)) {
    return "block";
  }

  const recentSubaction = [...recentConversationLines]
    .reverse()
    .map((line) => {
      if (isPermissionRequest(line)) return "request_permission";
      if (isStatusRequest(line)) return "status";
      if (isUnblockRequest(line)) return "unblock";
      if (isBlockRequest(line)) return "block";
      return null;
    })
    .find((value): value is Subaction => value !== null);

  if (!recentSubaction) {
    return null;
  }

  if (messageLooksLikeHostnameOnly(currentText)) {
    return recentSubaction;
  }

  if (
    recentSubaction === "block" &&
    DIRECT_CONFIRMATION_RE.test(currentText.trim())
  ) {
    return "block";
  }

  return null;
}

function coerceSubaction(value: unknown): Subaction | undefined {
  if (typeof value !== "string") return undefined;
  const n = value.trim().toLowerCase();
  if (
    n === "block" ||
    n === "unblock" ||
    n === "status" ||
    n === "request_permission"
  ) {
    return n;
  }
  return undefined;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0"].includes(normalized)) {
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

type OwnerWebsiteBlockPlan = {
  subaction: Subaction | null;
  shouldAct: boolean | null;
  response?: string;
};

function requireDelegatedHandler(
  action: Pick<Action, "handler" | "name">,
): NonNullable<Action["handler"]> {
  if (typeof action.handler !== "function") {
    throw new Error(`${action.name} handler is unavailable.`);
  }
  return action.handler;
}

async function resolveOwnerWebsiteBlockPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  params: OwnerWebsiteBlockParameters;
}): Promise<OwnerWebsiteBlockPlan> {
  const runModel = args.runtime.useModel;
  if (typeof runModel !== "function") {
    return { subaction: null, shouldAct: null };
  }

  const recentConversationLines = await collectRecentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 8,
  });
  const currentText = getMessageText(args.message);

  const heuristicSubaction = inferRecentSubaction(
    currentText,
    recentConversationLines,
  );
  if (heuristicSubaction) {
    return {
      subaction: heuristicSubaction,
      shouldAct: true,
    };
  }

  const recentConversation = recentConversationLines.join("\n");

  const prompt = [
    "Plan the OWNER_WEBSITE_BLOCK subaction for this request.",
    "Return ONLY valid JSON with exactly these fields:",
    '{"subaction":"block"|"unblock"|"status"|"request_permission"|null,"shouldAct":true|false,"response":"string|null"}',
    "",
    "OWNER_WEBSITE_BLOCK is the owner/admin umbrella for local website blocking on this Mac.",
    "Choose subaction=block for clear requests to block websites now, including direct requests like 'please block x.com for me' and follow-up confirmations like 'please do' or 'actually do it now' when recent conversation already named the websites.",
    "Choose subaction=unblock for requests to remove, stop, end, lift, or turn off the current website block.",
    "For subaction=unblock, hostname detail is optional because the action removes the current website block. Do not ask the user to identify what 'x' means when the intent is clearly to unblock the current website block.",
    "If the current request is only a hostname or URL and the recent conversation clearly established a website-block intent, preserve that prior intent. Example: user first says 'can you unblock x?' and then replies 'x.com' -> subaction=unblock.",
    "Choose subaction=status for questions about whether a website block is active, what sites are blocked, or when it ends.",
    "Choose subaction=request_permission for requests to pre-approve, allow, enable, or grant administrator/root approval for website blocking on this machine.",
    "Do NOT choose this action for app/device blocking on a phone or for general browsing advice.",
    "Set shouldAct=false only when the request is not actually about website blocking or when there is not enough information to know whether the user wants block, unblock, status, or permission flow.",
    "When shouldAct=false, response must be a short clarifying sentence in the user's language.",
    "",
    'Example: "please block x.com for me" -> {"subaction":"block","shouldAct":true,"response":null}',
    'Example: "remove the website block" -> {"subaction":"unblock","shouldAct":true,"response":null}',
    'Example: "can you unblock x?" -> {"subaction":"unblock","shouldAct":true,"response":null}',
    'Example: "what sites are blocked right now?" -> {"subaction":"status","shouldAct":true,"response":null}',
    'Example: "can we pre-approve website blocking on startup?" -> {"subaction":"request_permission","shouldAct":true,"response":null}',
    'Example: current request "x.com" with recent conversation about unblocking -> {"subaction":"unblock","shouldAct":true,"response":null}',
    "",
    "Current request:",
    currentText || "(empty)",
    "",
    "Structured parameters:",
    JSON.stringify(args.params),
    "",
    "Recent conversation:",
    recentConversation || "(none)",
  ].join("\n");

  try {
    const result = await runModel(ModelType.TEXT_SMALL, {
      prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    const parsed =
      parseDirectJsonObject(rawResponse) ??
      parseJSONObjectFromText(rawResponse) ??
      parseKeyValueXml<Record<string, unknown>>(rawResponse);
    if (!parsed) {
      return { subaction: null, shouldAct: null };
    }
    const subaction = coerceSubaction(parsed.subaction) ?? null;
    return {
      subaction,
      shouldAct: subaction ? true : normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:owner-website-block",
        error: error instanceof Error ? error.message : String(error),
      },
      "Owner website block planning model call failed",
    );
    return { subaction: null, shouldAct: null };
  }
}

export const ownerWebsiteBlockAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "BLOCK_WEBSITES",
    "UNBLOCK_WEBSITES",
    "GET_WEBSITE_BLOCK_STATUS",
    "REQUEST_WEBSITE_BLOCKING_PERMISSION",
    "WEBSITE_BLOCKER",
    "SELFCONTROL_BLOCK_WEBSITES",
  ],
  description:
    "Admin/owner-only. Manage local hosts-file website blocking on this Mac. " +
    "Subactions: block (start a block on a set of public hostnames for a fixed duration or indefinitely — always drafts first; requires confirmed: true to actually edit the hosts file), " +
    "unblock (remove the current website block), " +
    "status (check whether a block is active and when it ends), " +
    "request_permission (request administrator/root approval for hosts-file edits). " +
    "Use this for fixed-duration or generic focus blocks like 'block twitter and reddit for 2 hours' or 'turn on a focus block for all social media sites'. " +
    "Do NOT use this when the unblock condition is finishing a task, workout, or todo — that is BLOCK_UNTIL_TASK_COMPLETE. " +
    "Do NOT use this when the user references apps, games, or things 'on my phone' — those belong to OWNER_APP_BLOCK. " +
    "Do NOT use it for remote desktop sessions (OWNER_REMOTE_DESKTOP) or screen-time analytics (OWNER_SCREEN_TIME). " +
    "If the user asks to block or unblock websites and then replies with only a hostname in a follow-up message, keep the prior website-blocking intent from recent conversation and continue here. " +
    "Unblock requests do not require the user to restate every hostname; remove the current website block when the user clearly wants it gone. " +
    "Do not pair this action with a speculative REPLY; it provides its own final reply.",
  descriptionCompressed:
    "Admin: block/unblock websites via hosts file + status + permission request.",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    const access = await getSelfControlAccess(runtime, message);
    return access.allowed;
  },

  parameters: [
    {
      name: "subaction",
      description:
        "Required. One of: block, unblock, status, request_permission.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "websites",
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
        "Set true only when the owner has explicitly confirmed the block. Without it, block returns a draft confirmation request.",
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
          action: "OWNER_WEBSITE_BLOCK",
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
          action: "OWNER_WEBSITE_BLOCK",
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
          action: "OWNER_WEBSITE_BLOCK",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Please block x.com for me." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started a website block for x.com until you unblock it.",
          action: "OWNER_WEBSITE_BLOCK",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Can you unblock x?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Removed the website block for x.com before its scheduled end time.",
          action: "OWNER_WEBSITE_BLOCK",
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? SELFCONTROL_ACCESS_ERROR,
      } as ActionResult;
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as OwnerWebsiteBlockParameters;
    let subaction = coerceSubaction(params.subaction);
    if (!subaction) {
      const plan = await resolveOwnerWebsiteBlockPlanWithLlm({
        runtime,
        message,
        state,
        params,
      });
      subaction = plan.subaction ?? undefined;
      if (plan.shouldAct === false || !subaction) {
        return {
          success: true,
          text:
            plan.response ??
            "Tell me whether you want to block websites, unblock the current website block, check its status, or request permission for website blocking.",
          data: {
            actionName: ACTION_NAME,
            deferred: true,
            suggestedSubaction: plan.subaction ?? null,
          },
        } as ActionResult;
      }
    }

    if (!subaction) {
      return {
        success: false,
        text: "Missing or invalid subaction. Use one of: block, unblock, status, request_permission.",
      } as ActionResult;
    }

    if (subaction === "block") {
      return (await requireDelegatedHandler(blockWebsitesAction)(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    if (subaction === "unblock") {
      return (await requireDelegatedHandler(unblockWebsitesAction)(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    if (subaction === "status") {
      return (await requireDelegatedHandler(getWebsiteBlockStatusAction)(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    return (await requireDelegatedHandler(
      requestWebsiteBlockingPermissionAction,
    )(runtime, message, state, options, callback)) as ActionResult;
  },
};
