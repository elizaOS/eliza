import { type IAgentRuntime, stringToUuid, type UUID } from "@elizaos/core";

/**
 * The agent's web-chat world. Keyed by the agent id, so renaming an agent
 * keeps its conversations and two agents with one name never share a world.
 */
export function webChatWorldId(agentId: UUID): UUID {
  return stringToUuid(`${agentId}-web-chat-world`);
}

/**
 * Every world that can hold the agent's web-chat rooms: the id-keyed world,
 * then the legacy name-keyed world for the current name and for each name on
 * the agent's entity. A legacy room is read there until its next connection
 * moves it to the id-keyed world.
 */
export async function webChatWorldIds(runtime: IAgentRuntime): Promise<UUID[]> {
  const agentEntity = await runtime.getEntityById(runtime.agentId);
  const names = new Set([
    runtime.character.name ?? "Eliza",
    ...(agentEntity?.names ?? []),
  ]);
  return [
    webChatWorldId(runtime.agentId),
    ...Array.from(names, (name) => stringToUuid(`${name}-web-chat-world`)),
  ];
}
