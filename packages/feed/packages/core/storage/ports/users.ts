/**
 * User Storage Port
 *
 * Defines the interface for user data access.
 */

import type { PaginationOptions, UserRecord } from '../types';

export interface PointsTransactionRecord {
  id: string;
  userId: string;
  amount: number;
  pointsBefore: number;
  pointsAfter: number;
  reason: string;
  metadata?: string;
  createdAt: Date;
}

export interface UserPort {
  // User Operations
  getUser(id: string): Promise<UserRecord | null>;
  getUserByUsername(username: string): Promise<UserRecord | null>;
  getUserByWallet(walletAddress: string): Promise<UserRecord | null>;

  // Create/Update Operations
  createUser(
    user: Omit<UserRecord, 'createdAt' | 'updatedAt'>
  ): Promise<UserRecord>;
  updateUser(id: string, updates: Partial<UserRecord>): Promise<UserRecord>;
  deleteUser(id: string): Promise<void>;

  // Agent-specific queries
  getAgentUsers(options?: PaginationOptions): Promise<UserRecord[]>;
  getAgentsByManager(managerId: string): Promise<UserRecord[]>;

  // Balance Operations
  updateUserBalance(id: string, balance: string): Promise<void>;
  updateUserReputationPoints(id: string, points: number): Promise<void>;

  // Points Transactions
  createPointsTransaction(
    transaction: Omit<PointsTransactionRecord, 'id' | 'createdAt'>
  ): Promise<PointsTransactionRecord>;
  getUserPointsTransactions(
    userId: string,
    limit?: number
  ): Promise<PointsTransactionRecord[]>;

  // Existence check
  userExists(id: string): Promise<boolean>;
}
