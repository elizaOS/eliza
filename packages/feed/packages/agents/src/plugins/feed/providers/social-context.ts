/**
 * Social Context Providers
 *
 * Low-cost shared context extracted from group chats:
 * - Compact cross-chat facts
 * - Recent relevant group context
 * - Live player roster
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '../../../shared/logger';

type SharedChatFact = {
  chatId: string;
  chatName: string | null;
  fact: string;
  refreshedAt: string;
  lastMessageAt: string;
};

type RelevantGroupContext = {
  chatId: string;
  chatName: string | null;
  summary: string;
  facts: string[];
  participantNames: string[];
  messageCount: number;
  lastMessageAt: string;
  refreshedAt: string;
  recentMessages: Array<{
    speaker: string;
    content: string;
    createdAt: string;
  }>;
};

type LivePlayerRosterEntry = {
  id: string;
  username: string | null;
  displayName: string | null;
  isAgent: boolean;
  activeGroupChatCount: number;
  updatedAt: string;
};

type SharedChatContextServiceShape = {
  getSharedFacts: (options: { limit?: number }) => Promise<SharedChatFact[]>;
  getRelevantGroupContextForUser: (
    userId: string,
    options: {
      chatLimit?: number;
      messageWindowSize?: number;
      factLimit?: number;
      staleAfterMinutes?: number;
      refreshThreshold?: number;
    }
  ) => Promise<RelevantGroupContext[]>;
  getLivePlayerRoster: (options: {
    limit?: number;
  }) => Promise<LivePlayerRosterEntry[]>;
};

const SHARED_CHAT_CONTEXT_SERVICE_PATH =
  '../../../../../engine/src/services/shared-chat-context-service';

let sharedChatContextServicePromise: Promise<SharedChatContextServiceShape> | null =
  null;

async function getSharedChatContextService(): Promise<SharedChatContextServiceShape> {
  if (!sharedChatContextServicePromise) {
    sharedChatContextServicePromise = import(
      SHARED_CHAT_CONTEXT_SERVICE_PATH
    ).then(
      (module) =>
        module.sharedChatContextService as SharedChatContextServiceShape
    );
  }

  return sharedChatContextServicePromise;
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatRelativeTime(isoString: string): string {
  const timestamp = new Date(isoString).getTime();
  if (Number.isNaN(timestamp)) {
    return 'recently';
  }

  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export const sharedChatFactsProvider: Provider = {
  name: 'SHARED_CHAT_FACTS',
  description: 'Compact facts extracted from recent group chat summaries',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    try {
      const sharedChatContextService = await getSharedChatContextService();
      const facts = await sharedChatContextService.getSharedFacts({
        limit: 12,
      });

      if (facts.length === 0) {
        return {
          data: { facts: [], factCount: 0 },
          values: {
            sharedChatFacts: '',
            factCount: 0,
            hasSharedChatFacts: false,
          },
          text: '',
        };
      }

      const formattedFacts = facts
        .map(
          (fact, index) =>
            `${index + 1}. [${fact.chatName || fact.chatId}] ${fact.fact} (${formatRelativeTime(fact.refreshedAt)})`
        )
        .join('\n');

      return {
        data: { facts, factCount: facts.length },
        values: {
          sharedChatFacts: formattedFacts,
          factCount: facts.length,
          hasSharedChatFacts: true,
        },
        text: `[SHARED CHAT FACTS]\n${formattedFacts}\n[/SHARED CHAT FACTS]`,
      };
    } catch (error) {
      logger.warn(
        'Failed to fetch shared chat facts',
        error instanceof Error ? error.message : String(error),
        'SharedChatFactsProvider'
      );
      return {
        data: { facts: [], factCount: 0 },
        values: {
          sharedChatFacts: 'Shared chat facts unavailable.',
          factCount: 0,
          hasSharedChatFacts: false,
        },
        text: 'Shared chat facts unavailable.',
      };
    }
  },
};

export const recentRelevantGroupContextProvider: Provider = {
  name: 'RECENT_RELEVANT_GROUP_CONTEXT',
  description:
    'Recent summaries and compact message windows from the agent’s relevant group chats',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    try {
      const sharedChatContextService = await getSharedChatContextService();
      const contexts =
        await sharedChatContextService.getRelevantGroupContextForUser(
          runtime.agentId,
          {
            chatLimit: 10,
            messageWindowSize: 10,
            factLimit: 5,
            staleAfterMinutes: 30,
            refreshThreshold: 10,
          }
        );

      if (contexts.length === 0) {
        return {
          data: { contexts: [], contextCount: 0 },
          values: {
            recentRelevantGroupContext: '',
            contextCount: 0,
            hasRelevantGroupContext: false,
          },
          text: '',
        };
      }

      const formatted = contexts
        .map((context, index) => {
          const factsText =
            context.facts.length > 0
              ? context.facts.map((fact) => `  - ${fact}`).join('\n')
              : '  - None';
          const messagesText =
            context.recentMessages.length > 0
              ? context.recentMessages
                  .map(
                    (item) =>
                      `  - ${item.speaker}: ${truncateText(item.content, 160)} (${formatRelativeTime(item.createdAt)})`
                  )
                  .join('\n')
              : '  - No recent messages';

          return `Chat ${index + 1}: ${context.chatName || context.chatId}\nSummary: ${context.summary}\nFacts:\n${factsText}\nRecent messages:\n${messagesText}`;
        })
        .join('\n\n');

      return {
        data: { contexts, contextCount: contexts.length },
        values: {
          recentRelevantGroupContext: formatted,
          contextCount: contexts.length,
          hasRelevantGroupContext: true,
        },
        text: `[RECENT RELEVANT GROUP CONTEXT]\n${formatted}\n[/RECENT RELEVANT GROUP CONTEXT]`,
      };
    } catch (error) {
      logger.warn(
        'Failed to fetch recent relevant group context',
        error instanceof Error ? error.message : String(error),
        'RecentRelevantGroupContextProvider'
      );
      return {
        data: { contexts: [], contextCount: 0 },
        values: {
          recentRelevantGroupContext:
            'Recent relevant group context unavailable.',
          contextCount: 0,
          hasRelevantGroupContext: false,
        },
        text: 'Recent relevant group context unavailable.',
      };
    }
  },
};

export const livePlayerRosterProvider: Provider = {
  name: 'LIVE_PLAYER_ROSTER',
  description: 'Live roster of non-NPC users and agents currently in Feed',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    try {
      const sharedChatContextService = await getSharedChatContextService();
      const roster = await sharedChatContextService.getLivePlayerRoster({
        limit: 50,
      });

      if (roster.length === 0) {
        return {
          data: { roster: [], playerCount: 0 },
          values: {
            livePlayerRoster: '',
            playerCount: 0,
            hasLivePlayerRoster: false,
          },
          text: '',
        };
      }

      const formattedRoster = roster
        .map((player, index) => {
          const name = player.displayName || player.username || player.id;
          const handle = player.username ? `@${player.username}` : '';
          const role = player.isAgent ? 'Agent' : 'User';
          return `${index + 1}. ${name}${handle ? ` (${handle})` : ''} - ${role}, active group chats: ${player.activeGroupChatCount}`;
        })
        .join('\n');

      return {
        data: { roster, playerCount: roster.length },
        values: {
          livePlayerRoster: formattedRoster,
          playerCount: roster.length,
          hasLivePlayerRoster: true,
        },
        text: `[LIVE PLAYER ROSTER]\n${formattedRoster}\n[/LIVE PLAYER ROSTER]`,
      };
    } catch (error) {
      logger.warn(
        'Failed to fetch live player roster',
        error instanceof Error ? error.message : String(error),
        'LivePlayerRosterProvider'
      );
      return {
        data: { roster: [], playerCount: 0 },
        values: {
          livePlayerRoster: 'Live player roster unavailable.',
          playerCount: 0,
          hasLivePlayerRoster: false,
        },
        text: 'Live player roster unavailable.',
      };
    }
  },
};
