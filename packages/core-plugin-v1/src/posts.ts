import type { Actor, Memory } from './types.ts';
import { formatPosts as coreFormatPosts } from '@elizaos/core-plugin-v2';

export const formatPosts = ({
  messages,
  actors,
  conversationHeader = true,
}: {
  messages: Memory[];
  actors: Actor[];
  conversationHeader?: boolean;
}) => {
  return coreFormatPosts(messages, actors, conversationHeader);
};
