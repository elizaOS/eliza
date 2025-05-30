import { formatPosts as coreFormatPosts } from '../v2';
import type { Actor, Memory } from './types';

export const formatPosts = ({
  messages,
  actors,
  conversationHeader = true,
}: {
  messages: Memory[];
  actors: Actor[];
  conversationHeader?: boolean;
}) => {
  return coreFormatPosts(messages as any);
};
