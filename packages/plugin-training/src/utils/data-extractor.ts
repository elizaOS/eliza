import { type IAgentRuntime, elizaLogger, type Memory, type UUID, type Room } from '@elizaos/core';
import { type TrainingConfig, type DatasetStats } from '../types.js';

/**
 * Extracts training data from the ElizaOS database
 */
export class DataExtractor {
  constructor(private runtime: IAgentRuntime) {}

  async initialize(): Promise<void> {
    elizaLogger.info('Initializing Data Extractor');

    try {
      await this.runtime.getConnection();
    } catch (error) {
      throw new Error('Database connection not available');
    }
  }

  /**
   * Get all rooms based on extraction configuration
   */
  async getAllRooms(config: TrainingConfig['extractionConfig']): Promise<Room[]> {
    try {
      const rooms = (await (this.runtime as any).getRooms()) || [];

      // Filter rooms based on configuration
      let filteredRooms = rooms;

      // Filter by date range if specified
      if (config.startDate || config.endDate) {
        filteredRooms = await this.filterRoomsByDateRange(filteredRooms, config);
      }

      elizaLogger.info(`Found ${filteredRooms.length} rooms for extraction`);
      return filteredRooms;
    } catch (error) {
      elizaLogger.error('Error getting rooms:', error);
      throw error;
    }
  }

  private async filterRoomsByDateRange(
    rooms: Room[],
    config: TrainingConfig['extractionConfig']
  ): Promise<Room[]> {
    const filteredRooms: Room[] = [];

    for (const room of rooms) {
      // Get first and last message timestamps for the room
      const firstMessage = await this.getFirstMessage(room.id);
      const lastMessage = await this.getLastMessage(room.id);

      if (!firstMessage || !lastMessage) {
        continue;
      }

      const roomStart = new Date(firstMessage.createdAt || 0);
      const roomEnd = new Date(lastMessage.createdAt || 0);

      // Check if room overlaps with specified date range
      if (config.startDate && roomEnd < config.startDate) {
        continue;
      }
      if (config.endDate && roomStart > config.endDate) {
        continue;
      }

      filteredRooms.push(room);
    }

    return filteredRooms;
  }

  private async getFirstMessage(roomId: UUID): Promise<Memory | null> {
    try {
      const memories = await this.runtime.getMemories({
        roomId,
        count: 1,
        unique: true,
        tableName: 'messages',
      });
      return memories[0] || null;
    } catch (error) {
      elizaLogger.error(`Error getting first message for room ${roomId}:`, error);
      return null;
    }
  }

  private async getLastMessage(roomId: UUID): Promise<Memory | null> {
    try {
      // Get the most recent message
      const memories = await this.runtime.getMemories({
        roomId,
        count: 1,
        unique: true,
        tableName: 'messages',
        // Note: This assumes memories are returned in reverse chronological order
      });
      return memories[0] || null;
    } catch (error) {
      elizaLogger.error(`Error getting last message for room ${roomId}:`, error);
      return null;
    }
  }

  /**
   * Get comprehensive dataset statistics
   */
  async getDatasetStats(): Promise<DatasetStats> {
    elizaLogger.info('Calculating dataset statistics');

    try {
      const rooms = (await (this.runtime as any).getRooms()) || [];
      let totalMessages = 0;
      let totalActions = 0;
      let successfulActions = 0;
      const actionTypes: Record<string, number> = {};
      const topicDistribution: Record<string, number> = {};
      const messageLengths: number[] = [];
      const conversationLengths: number[] = [];
      let highQualityCount = 0;
      let lowQualityCount = 0;
      let earliestMessage: Date | null = null;
      let latestMessage: Date | null = null;

      const uniqueParticipants = new Set<string>();

      for (const room of rooms) {
        const memories = await this.runtime.getMemories({
          roomId: room.id,
          count: 10000,
          unique: true,
          tableName: 'messages',
        });

        if (memories.length === 0) {
          continue;
        }

        conversationLengths.push(memories.length);
        totalMessages += memories.length;

        // Get participants for this room
        const participants = await this.runtime.getParticipantsForRoom(room.id);
        participants.forEach((p: any) => uniqueParticipants.add(p.id));

        for (const memory of memories) {
          // Track message length
          messageLengths.push(memory.content.text?.length || 0);

          // Track timestamps
          const messageDate = new Date(memory.createdAt || 0);
          if (!earliestMessage || messageDate < earliestMessage) {
            earliestMessage = messageDate;
          }
          if (!latestMessage || messageDate > latestMessage) {
            latestMessage = messageDate;
          }

          // Track actions
          if (memory.content.actions) {
            totalActions += memory.content.actions.length;
            memory.content.actions.forEach((action: any) => {
              actionTypes[action] = (actionTypes[action] || 0) + 1;
            });
          }

          // Estimate successful actions (simplified)
          if (memory.entityId === this.runtime.agentId && memory.content.actions) {
            successfulActions += memory.content.actions.length; // Assume agent actions were successful
          }

          // Extract topics (simplified - based on content keywords)
          if (memory.content.text) {
            const topics = this.extractTopics(memory.content.text);
            topics.forEach((topic) => {
              topicDistribution[topic] = (topicDistribution[topic] || 0) + 1;
            });
          }
        }

        // Calculate conversation quality (simplified)
        const avgMessageLength =
          messageLengths.slice(-memories.length).reduce((a, b) => a + b, 0) / memories.length;
        if (avgMessageLength > 100) {
          highQualityCount++;
        } else if (avgMessageLength < 20) {
          lowQualityCount++;
        }
      }

      const averageConversationLength =
        conversationLengths.length > 0
          ? conversationLengths.reduce((a, b) => a + b, 0) / conversationLengths.length
          : 0;

      const averageMessageLength =
        messageLengths.length > 0
          ? messageLengths.reduce((a, b) => a + b, 0) / messageLengths.length
          : 0;

      const averageQuality =
        totalMessages > 0
          ? (highQualityCount * 1.0 + (totalMessages - highQualityCount - lowQualityCount) * 0.5) /
            totalMessages
          : 0;

      const timeSpanDays =
        earliestMessage && latestMessage
          ? Math.ceil((latestMessage.getTime() - earliestMessage.getTime()) / (1000 * 60 * 60 * 24))
          : 0;

      const stats: DatasetStats = {
        totalConversations: rooms.length,
        totalMessages,
        averageConversationLength,
        averageMessageLength,
        participantCount: uniqueParticipants.size,
        timeSpan: {
          start: earliestMessage || new Date(),
          end: latestMessage || new Date(),
          durationDays: timeSpanDays,
        },
        actionStats: {
          totalActions,
          successfulActions,
          actionTypes,
        },
        qualityMetrics: {
          averageQuality,
          highQualityCount,
          lowQualityCount,
        },
        topicDistribution,
      };

      elizaLogger.info('Dataset statistics calculated', { stats });
      return stats;
    } catch (error) {
      elizaLogger.error('Error calculating dataset statistics:', error);
      throw error;
    }
  }

  private extractTopics(text: string): string[] {
    const topics: string[] = [];
    const lowercaseText = text.toLowerCase();

    // Simple keyword-based topic extraction
    const topicKeywords = {
      programming: ['code', 'program', 'development', 'software', 'bug', 'function', 'api'],
      ai: ['ai', 'artificial intelligence', 'machine learning', 'neural', 'model'],
      web: ['website', 'web', 'html', 'css', 'javascript', 'react', 'frontend'],
      data: ['data', 'database', 'sql', 'analytics', 'dataset'],
      business: ['business', 'market', 'customer', 'revenue', 'strategy'],
      technology: ['technology', 'tech', 'innovation', 'digital', 'cloud'],
      communication: ['chat', 'message', 'email', 'communication', 'discuss'],
      'problem-solving': ['problem', 'solution', 'fix', 'resolve', 'debug'],
    };

    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some((keyword) => lowercaseText.includes(keyword))) {
        topics.push(topic);
      }
    }

    return topics;
  }

  /**
   * Get memories for a specific room with additional filtering
   */
  async getFilteredMemories(
    roomId: UUID,
    config: TrainingConfig['extractionConfig']
  ): Promise<Memory[]> {
    try {
      let memories = await this.runtime.getMemories({
        roomId,
        count: 10000,
        unique: true,
        tableName: 'messages',
      });

      // Filter by date range
      if (config.startDate) {
        memories = memories.filter(
          (memory: any) => new Date(memory.createdAt || 0) >= config.startDate!
        );
      }

      if (config.endDate) {
        memories = memories.filter(
          (memory: any) => new Date(memory.createdAt || 0) <= config.endDate!
        );
      }

      // Filter by status if specified
      if (config.filterByStatus && config.filterByStatus.length > 0) {
        memories = memories.filter((memory: any) => {
          const status = memory.metadata?.status;
          return status && config.filterByStatus!.includes(status);
        });
      }

      // Filter system messages if not included
      if (!config.includeSystemMessages) {
        memories = memories.filter(
          (memory) => memory.content.text && memory.content.text.trim().length > 0
        );
      }

      return memories;
    } catch (error) {
      elizaLogger.error(`Error getting filtered memories for room ${roomId}:`, error);
      throw error;
    }
  }
}
