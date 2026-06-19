/**
 * BLOCK action — focus / distraction-control umbrella.
 *
 * STATUS: stub. The live BLOCK umbrella action (plus the app-target and
 * website-target dispatch handlers) is still owned by the personal-assistant
 * plugin, whose persistence couples to the lifeops SQL layer. The blocking
 * platform (engine + services + providers) now lives here under src/services
 * and src/providers.
 *
 * Target / subaction matrix (preserve when migrating):
 *   app:     block, unblock, status
 *   website: block, unblock, status, request_permission, release, list_active
 *
 * TODO(migration): when the BLOCK action moves here, dispatch by target into
 * ../services/app-blocker and ../services/website-blocker and drop the dispatch
 * wrappers in the personal-assistant plugin once parity is verified.
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

export const blockAction: Action = {
  // Literal (not a const) so the VIEW_ACTION_MAP drift guard can statically see
  // it — the `focus` view emphasizes this BLOCK umbrella.
  name: "BLOCK",
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
      description:
        "What to block: app (native macOS/mobile app) or website (hostname).",
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
    // TODO(migration): port appBlockValidate / websiteBlockValidate from the
    // personal-assistant plugin's app-block / website-block action handlers.
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
    // the personal-assistant plugin's app-block / website-block action handlers
    // and dispatch by target. Until then the stub returns a deferred result so
    // the planner can still register the action shape.
    const text = `${BLOCKER_LOG_PREFIX} BLOCK action not yet migrated from plugin-lifeops.`;
    return {
      success: false,
      text,
      error: new Error(text),
    };
  },
  examples: [],
};
