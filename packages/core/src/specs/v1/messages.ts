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
  throw new Error('getActorDetails is not implemented.');
}

/**
 * Format actors into a string
 * @param actors - list of actors
 * @returns string
 */
export function formatActors({ actors }: { actors: Actor[] }) {
  if (!actors || actors.length === 0) {
    return 'No actors available.';
  }
  return actors.map((actor) => actor.name).join(', ');
}

/**
 * Format messages into a string
 * @param {Object} params - The parameters object
 * @param {Memory[]} params.messages - list of messages
 * @param {Actor[]} params.actors - list of actors
 * @returns string
 */
export const formatMessages = ({ messages, actors }: { messages: Memory[]; actors: Actor[] }) => {
  return coreFormatMessages(messages as any);
};

export const formatTimestamp = (messageDate: number) => {
  return coreFormatTimestamp(messageDate);
};
