/**
 * JSON User Adapter
 */

import type { PointsTransactionRecord, UserPort } from '../../../ports/users';
import type { PaginationOptions, UserRecord } from '../../../types';
import type { JsonIdGenerator } from '../id-generator';
import type { JsonStorageState } from '../types';

export class JsonUserAdapter implements UserPort {
  constructor(
    private state: JsonStorageState,
    private idGen: JsonIdGenerator,
    private onChange: () => void
  ) {}

  async getUser(id: string): Promise<UserRecord | null> {
    return this.state.users[id] ?? null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const lowerUsername = username.toLowerCase();
    return (
      Object.values(this.state.users).find(
        (u) => u.username.toLowerCase() === lowerUsername
      ) ?? null
    );
  }

  async getUserByWallet(walletAddress: string): Promise<UserRecord | null> {
    const lowerWallet = walletAddress.toLowerCase();
    return (
      Object.values(this.state.users).find(
        (u) => u.walletAddress?.toLowerCase() === lowerWallet
      ) ?? null
    );
  }

  async createUser(
    user: Omit<UserRecord, 'createdAt' | 'updatedAt'>
  ): Promise<UserRecord> {
    const now = new Date();
    const record: UserRecord = {
      ...user,
      createdAt: now,
      updatedAt: now,
    };
    this.state.users[user.id] = record;
    this.onChange();
    return record;
  }

  async updateUser(
    id: string,
    updates: Partial<UserRecord>
  ): Promise<UserRecord> {
    const user = this.state.users[id];
    if (!user) {
      throw new Error(`User not found: ${id}`);
    }

    Object.assign(user, updates, { updatedAt: new Date() });
    this.onChange();
    return user;
  }

  async deleteUser(id: string): Promise<void> {
    delete this.state.users[id];
    this.onChange();
  }

  async getAgentUsers(options?: PaginationOptions): Promise<UserRecord[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    return Object.values(this.state.users)
      .filter((u) => u.isAgent)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit);
  }

  async getAgentsByManager(managerId: string): Promise<UserRecord[]> {
    return Object.values(this.state.users)
      .filter((u) => u.isAgent && u.managedBy === managerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async updateUserBalance(id: string, balance: string): Promise<void> {
    const user = this.state.users[id];
    if (user) {
      user.virtualBalance = balance;
      user.updatedAt = new Date();
      this.onChange();
    }
  }

  async updateUserReputationPoints(id: string, points: number): Promise<void> {
    const user = this.state.users[id];
    if (user) {
      user.reputationPoints = points;
      user.updatedAt = new Date();
      this.onChange();
    }
  }

  async createPointsTransaction(
    transaction: Omit<PointsTransactionRecord, 'id' | 'createdAt'>
  ): Promise<PointsTransactionRecord> {
    const record: PointsTransactionRecord = {
      ...transaction,
      id: this.idGen.generate('transaction'),
      createdAt: new Date(),
    };
    this.state.pointsTransactions.push(record);
    this.onChange();
    return record;
  }

  async getUserPointsTransactions(
    userId: string,
    limit = 100
  ): Promise<PointsTransactionRecord[]> {
    return this.state.pointsTransactions
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async userExists(id: string): Promise<boolean> {
    return id in this.state.users;
  }
}
