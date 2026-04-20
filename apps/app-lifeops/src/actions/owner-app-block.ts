/**
 * OWNER_APP_BLOCK — Tier 2-C umbrella.
 *
 * Collapses phone-app blocking (block / unblock / status) into a single
 * owner-only action dispatched by a required `subaction` parameter. Routes to
 * the existing handlers in app-blocker.ts.
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
  APP_BLOCKER_ACCESS_ERROR,
  getAppBlockerAccess,
} from "../app-blocker/access.ts";
import {
  blockAppsAction,
  unblockAppsAction,
  getAppBlockStatusAction,
} from "./app-blocker.js";

const ACTION_NAME = "OWNER_APP_BLOCK";

type Subaction = "block" | "unblock" | "status";

interface OwnerAppBlockParameters {
  subaction?: Subaction | string;
  packageNames?: string[];
  appTokens?: string[];
  durationMinutes?: number | null;
}

function coerceSubaction(value: unknown): Subaction | undefined {
  if (typeof value !== "string") return undefined;
  const n = value.trim().toLowerCase();
  if (n === "block" || n === "unblock" || n === "status") return n;
  return undefined;
}

export const ownerAppBlockAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "BLOCK_APPS",
    "UNBLOCK_APPS",
    "GET_APP_BLOCK_STATUS",
    "APP_BLOCKER",
    "SHIELD_APPS",
  ],
  description:
    "Admin/owner-only. Manage native phone-app blocking via Family Controls (iPhone) or Usage Access (Android). " +
    "Subactions: block (start blocking a set of apps — requires packageNames on Android or previously selected appTokens on iPhone; optional durationMinutes), " +
    "unblock (remove the active app block), " +
    "status (report whether an app block is active and when it ends). " +
    "Use this ONLY for apps on the owner's phone. Do NOT use it for desktop website blocking — that belongs to OWNER_WEBSITE_BLOCK. " +
    "Do NOT use it for screen-time analytics (OWNER_SCREEN_TIME) or remote desktop sessions (OWNER_REMOTE_DESKTOP). " +
    "Do not pair this action with a speculative REPLY; it provides its own final reply.",
  descriptionCompressed:
    "Admin: block/unblock phone apps + check status (Family Controls / Usage Access).",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    const access = await getAppBlockerAccess(runtime, message);
    return access.allowed;
  },

  parameters: [
    {
      name: "subaction",
      description: "Required. One of: block, unblock, status.",
      required: true,
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
      description: "How long to block the apps, in minutes. Omit for indefinite block.",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Block Twitter and Instagram on my phone for 2 hours." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Started blocking 2 apps until the block expires.",
          action: "OWNER_APP_BLOCK",
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
          action: "OWNER_APP_BLOCK",
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
          action: "OWNER_APP_BLOCK",
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
    const access = await getAppBlockerAccess(runtime, message);
    if (!access.allowed) {
      return {
        success: false,
        text: access.reason ?? APP_BLOCKER_ACCESS_ERROR,
      } as ActionResult;
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as OwnerAppBlockParameters;
    const subaction = coerceSubaction(params.subaction);
    if (!subaction) {
      return {
        success: false,
        text: "Missing or invalid subaction. Use one of: block, unblock, status.",
      } as ActionResult;
    }

    if (subaction === "block") {
      return (await blockAppsAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    if (subaction === "unblock") {
      return (await unblockAppsAction.handler!(
        runtime,
        message,
        state,
        options,
        callback,
      )) as ActionResult;
    }
    return (await getAppBlockStatusAction.handler!(
      runtime,
      message,
      state,
      options,
      callback,
    )) as ActionResult;
  },
};
