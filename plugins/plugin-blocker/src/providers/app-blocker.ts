/**
 * appBlockerProvider — injects the user's current app-block state into the
 * planner each turn (active sessions, blocked bundle ids, allow-list size).
 *
 * STATUS: stub. The real implementation lives in:
 *   plugins/plugin-lifeops/src/providers/app-blocker.ts
 *
 * TODO(migration): move the source file here and repoint its service import
 * from the lifeops-local engine to ../services/app-blocker.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import { AppBlockerService } from "../services/app-blocker.ts";
import { APP_BLOCKER_SERVICE_TYPE, BLOCKER_CONTEXTS } from "../types.ts";

export const appBlockerProvider: Provider = {
  name: "APP_BLOCKER",
  description:
    "Active app block sessions and override status for the current user.",
  position: -3,
  contexts: [...BLOCKER_CONTEXTS],
  contextGate: { anyOf: [...BLOCKER_CONTEXTS] },
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService<AppBlockerService>(
      APP_BLOCKER_SERVICE_TYPE,
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
