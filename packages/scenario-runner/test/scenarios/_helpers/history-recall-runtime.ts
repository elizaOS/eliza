/**
 * Boots the production agent memory surface inside history-recall scenarios
 * and stamps the scenario speaker as the owner. The runtime gate under test
 * requires both a registered search action and a role that can execute it.
 */

import { createElizaPlugin } from "@elizaos/agent/runtime/eliza-plugin";
import {
  ChannelType,
  type IAgentRuntime,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

export async function prepareOwnerMemoryRuntime(
  ctx: ScenarioContext,
): Promise<IAgentRuntime | string> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime) return "scenario runtime was not available";
  if (!ctx.primaryRoomId || !ctx.primaryUserId || !ctx.scenarioId) {
    return "executor did not expose scenario, room, and user ids to seeds";
  }

  if (!runtime.actions.some((action) => action.name === "MEMORY")) {
    await runtime.registerPlugin(createElizaPlugin());
  }

  const entityId = ctx.primaryUserId as UUID;
  const roomId = ctx.primaryRoomId as UUID;
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId: stringToUuid(`scenario-runner-world:${ctx.scenarioId}`),
    userName: "History recall owner",
    source: "chat",
    channelId: roomId,
    type: ChannelType.DM,
    metadata: {
      ownership: { ownerId: entityId },
      roles: { [entityId]: "OWNER" },
    },
  });

  return runtime;
}
