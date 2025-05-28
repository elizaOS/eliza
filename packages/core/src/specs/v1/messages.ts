import {
  formatMessages as coreFormatMessages,
  formatTimestamp as coreFormatTimestamp,
} from '../v2';

import type { Actor, IAgentRuntime, Memory, UUID } from './types';

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
  return coreFormatMessages(messages as any);
};

export const formatTimestamp = (messageDate: number) => {
  return coreFormatTimestamp(messageDate);
};
