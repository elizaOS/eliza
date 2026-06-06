/**
 * BLOCK action — focus / distraction-control umbrella.
 *
 * STATUS: stub. The real implementation lives in:
 *   plugins/plugin-lifeops/src/actions/block.ts            — umbrella action
 *   plugins/plugin-lifeops/src/actions/app-block.ts        — app-target dispatch
 *   plugins/plugin-lifeops/src/actions/website-block.ts    — website-target dispatch
 *
 * Target / subaction matrix (preserve when migrating):
 *   app:     block, unblock, status
 *   website: block, unblock, status, request_permission, release, list_active
 *
 * TODO(migration):
 *   1. Move the listed action files into this directory.
 *   2. Repoint imports from ../app-blocker / ../website-blocker (lifeops-local)
 *      to ../services/app-blocker / ../services/website-blocker (this plugin).
 *   3. Drop the dispatch wrappers in plugin-lifeops once parity is verified.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import {
  BLOCK_SUBACTIONS,
  BLOCK_TARGETS,
  BLOCKER_CONTEXTS,
  BLOCKER_LOG_PREFIX,
} from "../types.ts";

const ACTION_NAME = "BLOCK";

export const blockAction: Action = {
  name: ACTION_NAME,
  contexts: [...BLOCKER_CONTEXTS],
  roleGate: { minRole: "ADMIN" },
  contextGate: { anyOf: [...BLOCKER_CONTEXTS] },
  tags: [
    "domain:focus",
    "capability:write",
    "capability:update",
    "surface:internal",
  ],
  similes: [
    "FOCUS",
    "FOCUS_MODE",
    "BLOCK_WEBSITE",
    "BLOCK_SITE",
    "BLOCK_APP",
    "UNBLOCK_WEBSITE",
    "UNBLOCK_APP",
    "START_FOCUS",
    "END_FOCUS",
    "STOP_DISTRACTION",
    "SELFCONTROL",
  ],
  description:
    "Focus / distraction control. Block or unblock websites (SelfControl-style hosts-file rules) and macOS apps, manage allow-lists, and review active block sessions. Targets: app (block/unblock/status) and website (block/unblock/status/request_permission/release/list_active).",
  descriptionCompressed:
    "focus: block|unblock|status|request_permission|release|list_active for target=app|website",
  parameters: [
    {
      name: "target",
      description: "What to block: app (native macOS/mobile app) or website (hostname).",
      required: true,
      schema: { type: "string" as const, enum: [...BLOCK_TARGETS] },
    },
    {
      name: "action",
      description:
        "Subaction: block, unblock, status, request_permission, release, list_active.",
      required: true,
      schema: { type: "string" as const, enum: [...BLOCK_SUBACTIONS] },
    },
    {
      name: "pattern",
      description:
        "Bundle id (target=app) or hostname / hostname pattern (target=website).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "durationMs",
      description: "Optional duration of the block session in milliseconds.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(migration): port appBlockValidate / websiteBlockValidate from
    // plugins/plugin-lifeops/src/actions/{app-block,website-block}.ts.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // TODO(migration): port runAppBlockHandler / runWebsiteBlockHandler from
    // plugins/plugin-lifeops/src/actions/{app-block,website-block}.ts and
    // dispatch by target. Until then the stub returns a deferred result so the
    // planner can still register the action shape.
    const text = `${BLOCKER_LOG_PREFIX} BLOCK action not yet migrated from plugin-lifeops.`;
    return {
      success: false,
      text,
      error: new Error(text),
    };
  },
  examples: [],
};
