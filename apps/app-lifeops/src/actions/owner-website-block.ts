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
} from "@elizaos/core";
import {
  SELFCONTROL_ACCESS_ERROR,
  getSelfControlAccess,
} from "../website-blocker/access.ts";
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
      description: "Required. One of: block, unblock, status, request_permission.",
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
        "How long to block, in minutes. Omit to use the default duration (60). Null for indefinite.",
      required: false,
      schema: { type: "number" as const, default: 60 },
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
          text: "Ready to block x.com, twitter.com for 120 minutes. Reply \"confirm\" or re-issue with confirmed: true to start the block.",
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
        content: { text: "Give yourself permission to block websites on this machine." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "The approval prompt completed successfully. Eliza can now ask the OS for administrator approval whenever it needs to edit the hosts file.",
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
    const subaction = coerceSubaction(params.subaction);
    if (!subaction) {
      return {
        success: false,
        text: "Missing or invalid subaction. Use one of: block, unblock, status, request_permission.",
      } as ActionResult;
    }

    if (subaction === "block") {
      return (await blockWebsitesAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    if (subaction === "unblock") {
      return (await unblockWebsitesAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    if (subaction === "status") {
      return (await getWebsiteBlockStatusAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    return (await requestWebsiteBlockingPermissionAction.handler!(
      runtime,
      message,
      state,
      options,
      callback,
    )) as ActionResult;
  },
};
