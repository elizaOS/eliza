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
  const entities = actors.map((actor) => ({
    id: actor.id,
    names: [actor.name, actor.username].filter(Boolean) as string[],
    metadata: actor.details,
    agentId: undefined as any, // agentId is not available on v1 Actor and not used by coreFormatPosts
  }));
  return coreFormatPosts({
    messages: messages as any,
    entities: entities as any,
    conversationHeader,
  });
};
