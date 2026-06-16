/**
 * websiteBlockerProvider — injects the user's current website-block state into
 * the planner each turn (active sessions, allow-list size, override eligibility).
 *
 * STATUS: stub. The real implementation lives in:
 *   plugins/plugin-personal-assistant/src/providers/website-blocker.ts
 *
 * TODO(migration): move the source file here and repoint its service import
 * from the lifeops-local engine to ../services/website-blocker.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import type { WebsiteBlockerService } from "../services/website-blocker.ts";
import { BLOCKER_CONTEXTS, WEBSITE_BLOCKER_SERVICE_TYPE } from "../types.ts";

export const websiteBlockerProvider: Provider = {
  name: "WEBSITE_BLOCKER",
  description:
    "Active website block sessions (SelfControl-style hosts rules) and override status for the current user.",
  position: -3,
  contexts: [...BLOCKER_CONTEXTS],
  contextGate: { anyOf: [...BLOCKER_CONTEXTS] },
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<WebsiteBlockerService>(
      WEBSITE_BLOCKER_SERVICE_TYPE,
    );
    if (!service) return { text: "", data: { sessions: [] } };
    // TODO(migration): use the real listActive() once ported.
    const sessions = await service.listActive();
    return {
      text: "",
      data: { sessions },
    };
  },
};
