/**
 * JSON Agent Adapter
 */

import type {
  AgentLogRecord,
  AgentMessageRecord,
  AgentPointsTransactionRecord,
  AgentPort,
} from '../../../ports/agents';
import type {
  AgentConfigRecord,
  AgentTradeRecord,
  PaginationOptions,
} from '../../../types';
import type { JsonIdGenerator } from '../id-generator';
import type { JsonStorageState } from '../types';

export class JsonAgentAdapter implements AgentPort {
  constructor(
    private state: JsonStorageState,
    private idGen: JsonIdGenerator,
    private onChange: () => void
  ) {}

  async getAgentConfig(userId: string): Promise<AgentConfigRecord | null> {
    return this.state.agentConfigs[userId] ?? null;
  }

  async createAgentConfig(
    config: Omit<AgentConfigRecord, 'updatedAt'>
  ): Promise<AgentConfigRecord> {
    const now = new Date();
    const record: AgentConfigRecord = {
      ...config,
      updatedAt: now,
    };
    this.state.agentConfigs[config.userId] = record;
    this.onChange();
    return record;
  }

  async updateAgentConfig(
    userId: string,
    updates: Partial<AgentConfigRecord>
  ): Promise<AgentConfigRecord> {
    const existing = this.state.agentConfigs[userId];
    if (!existing) {
      throw new Error(`Agent config not found: ${userId}`);
    }

    const updated: AgentConfigRecord = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    this.state.agentConfigs[userId] = updated;
    this.onChange();
    return updated;
  }

  async deleteAgentConfig(userId: string): Promise<void> {
    delete this.state.agentConfigs[userId];
    this.onChange();
  }

  async getAgentLogs(
    agentUserId: string,
    options?: PaginationOptions & { type?: string; level?: string }
  ): Promise<AgentLogRecord[]> {
    let logs = this.state.agentLogs.filter(
      (l) => l.agentUserId === agentUserId
    );

    if (options?.type) {
      logs = logs.filter((l) => l.type === options.type);
    }
    if (options?.level) {
      logs = logs.filter((l) => l.level === options.level);
    }

    // Sort by createdAt descending
    logs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    return logs.slice(offset, offset + limit);
  }

  async createAgentLog(
    log: Omit<AgentLogRecord, 'id' | 'createdAt'>
  ): Promise<AgentLogRecord> {
    const record: AgentLogRecord = {
      ...log,
      id: this.idGen.generate('log'),
      createdAt: new Date(),
    };
    this.state.agentLogs.push(record);
    this.onChange();
    return record;
  }

  async getAgentMessages(
    agentUserId: string,
    limit = 50
  ): Promise<AgentMessageRecord[]> {
    const messages = this.state.agentMessages
      .filter((m) => m.agentUserId === agentUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
    return messages;
  }

  async createAgentMessage(
    message: Omit<AgentMessageRecord, 'id' | 'createdAt'>
  ): Promise<AgentMessageRecord> {
    const record: AgentMessageRecord = {
      ...message,
      id: this.idGen.generate('message'),
      createdAt: new Date(),
    };
    this.state.agentMessages.push(record);
    this.onChange();
    return record;
  }

  async getAgentPointsTransactions(
    agentUserId: string,
    limit = 100
  ): Promise<AgentPointsTransactionRecord[]> {
    return this.state.agentPointsTransactions
      .filter((t) => t.agentUserId === agentUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async createAgentPointsTransaction(
    transaction: Omit<AgentPointsTransactionRecord, 'id' | 'createdAt'>
  ): Promise<AgentPointsTransactionRecord> {
    const record: AgentPointsTransactionRecord = {
      ...transaction,
      id: this.idGen.generate('transaction'),
      createdAt: new Date(),
    };
    this.state.agentPointsTransactions.push(record);
    this.onChange();
    return record;
  }

  async getAgentTrades(
    agentUserId: string,
    limit = 100
  ): Promise<AgentTradeRecord[]> {
    return this.state.agentTrades
      .filter((t) => t.agentUserId === agentUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async createAgentTrade(
    trade: Omit<AgentTradeRecord, 'id' | 'createdAt'>
  ): Promise<AgentTradeRecord> {
    const record: AgentTradeRecord = {
      ...trade,
      id: this.idGen.generate('trade'),
      createdAt: new Date(),
    };
    this.state.agentTrades.push(record);
    this.onChange();
    return record;
  }

  async listAgentsWithAutonomousTrading(): Promise<AgentConfigRecord[]> {
    return Object.values(this.state.agentConfigs).filter(
      (c) => c.autonomousTrading
    );
  }
}
