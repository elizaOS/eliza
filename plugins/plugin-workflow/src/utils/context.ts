/**
 * Conversation-context helpers for workflow actions. Ownership tag names carry
 * both user and agent identities so they remain tenant-safe even when a client
 * points at a shared workflow backend that is not the embedded store.
 */
import {
  type IAgentRuntime,
  type Memory,
  resolveCanonicalOwnerId,
  type State,
  stringToUuid,
  type UUID,
} from '@elizaos/core';

/**
 * Resolve the single local owner identity shared by app routes and client chat.
 * Legacy plugin-route headers cannot supply this value because they are
 * caller-controlled; a trusted dispatcher can still pass a different
 * principal explicitly at its boundary.
 */
export function getLocalOwnerEntityId(runtime: IAgentRuntime): string {
  const canonicalOwnerId = resolveCanonicalOwnerId(runtime);
  if (typeof canonicalOwnerId === 'string' && canonicalOwnerId.trim()) {
    return canonicalOwnerId.trim();
  }

  const agentName = runtime.character?.name?.trim() || 'Eliza';
  return stringToUuid(`${agentName}-admin-entity`);
}

export function buildConversationContext(message: Memory, state: State | undefined): string {
  const raw = state?.values?.recentMessages;
  const recentMessages = typeof raw === 'string' ? raw : '';
  const currentText = message.content.text ?? '';

  if (!recentMessages) {
    return currentText;
  }

  return `${recentMessages}\n\nCurrent request: ${currentText}`;
}

export async function getUserTagName(runtime: IAgentRuntime, userId: string): Promise<string> {
  const entity = await runtime.getEntityById(userId as UUID);
  const shortId = userId.replace(/-/g, '').slice(0, 8);
  const agentScopeId = runtime.agentId.replace(/-/g, '');
  const name = entity?.names?.[0];
  const isDefaultName = name === `User ${userId}` || name === `User${userId}`;
  const isRealName = name && !isDefaultName;
  const userTag = isRealName ? `${name}_${shortId}` : `user_${shortId}`;
  return `${userTag}_agent_${agentScopeId}`;
}
