import type { IAgentRuntime, Memory, State, UUID } from '@elizaos/core';

export function buildConversationContext(message: Memory, state: State | undefined): string {
  const raw = state?.values?.recentMessages;
  const recentMessages = typeof raw === 'string' ? raw : '';
  const currentText = message.content?.text ?? '';

  if (!recentMessages) {
    return currentText;
  }

  return `${recentMessages}\n\nCurrent request: ${currentText}`;
}

export async function getUserTagName(runtime: IAgentRuntime, userId: string): Promise<string> {
  const entity = await runtime.getEntityById(userId as UUID);
  const shortId = userId.replace(/-/g, '').slice(0, 8);
  const name = entity?.names?.[0];
  // ElizaOS default name is "User" + UUID — not useful for a tag
  const isRealName = name && !name.includes(userId.slice(0, 8));
  return isRealName ? `${name}_${shortId}` : `user_${shortId}`;
}
