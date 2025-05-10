import {
  formatMessages as coreFormatMessages,
  formatTimestamp as coreFormatTimestamp,
} from '@elizaos/core-plugin-v2';

import type { IAgentRuntime, Actor, Content, Memory, UUID } from './types.ts';

/**
 * Get details for a list of actors.
 */
export async function getActorDetails({
  runtime,
  roomId,
}: {
  runtime: IAgentRuntime;
  roomId: UUID;
}) {
  // WRITE ME
}

/**
 * Format actors into a string
 * @param actors - list of actors
 * @returns string
 */
export function formatActors({ actors }: { actors: Actor[] }) {
  // WRITE ME
}

/**
 * Format messages into a string
 * @param messages - list of messages
 * @param actors - list of actors
 * @returns string
 */
export const formatMessages = ({ messages, actors }: { messages: Memory[]; actors: Actor[] }) => {
  return coreFormatMessages(message, actors);
};

export const formatTimestamp = (messageDate: number) => {
  return coreFormatTimestamp(messageDate);
};
