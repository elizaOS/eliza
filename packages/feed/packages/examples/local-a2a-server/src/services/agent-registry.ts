/**
 * Agent Registry Service
 * Handles agent registration, lookup, and verification
 */

import type { Database } from 'bun:sqlite';
import type { LocalBlockchain } from './local-blockchain';

interface Agent {
  id: string;
  walletAddress: string;
  tokenId: number;
  chainId: number;
  displayName: string;
  description: string;
  avatarUrl: string;
  createdAt: Date;
  isVerified: boolean;
  metadata: Record<string, unknown>;
}

interface AgentRegistration {
  walletAddress: string;
  tokenId: number;
  chainId: number;
  displayName?: string;
  description?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
}

export class AgentRegistry {
  constructor(
    private db: Database,
    private blockchain: LocalBlockchain
  ) {}

  /**
   * Register a new agent
   */
  async registerAgent(registration: AgentRegistration): Promise<Agent> {
    const id = `agent-${registration.chainId}-${registration.tokenId}`;
    const now = new Date().toISOString();

    // Check if agent already exists by ID
    const existingById = this.db
      .query('SELECT * FROM agents WHERE id = ?')
      .get(id) as Record<string, unknown> | null;
    if (existingById) {
      throw new Error(`Agent ${id} already registered`);
    }

    // Check if agent already exists by wallet address
    const existingByWallet = this.db
      .query('SELECT * FROM agents WHERE wallet_address = ?')
      .get(registration.walletAddress) as Record<string, unknown> | null;
    if (existingByWallet) {
      // Return the existing agent instead of throwing
      return this.rowToAgent(existingByWallet);
    }

    // Verify on-chain registration if blockchain is available
    const isVerified = await this.blockchain.verifyAgentRegistration(
      registration.walletAddress,
      registration.tokenId
    );

    // Insert agent
    this.db.run(
      `
      INSERT INTO agents (
        id, wallet_address, token_id, chain_id, display_name, 
        description, avatar_url, created_at, is_verified, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      id,
      registration.walletAddress,
      registration.tokenId,
      registration.chainId,
      registration.displayName || `Agent ${registration.tokenId}`,
      registration.description || '',
      registration.avatarUrl || '',
      now,
      isVerified ? 1 : 0,
      JSON.stringify(registration.metadata || {})
    );

    // Also create user record for social features
    await this.ensureUserExists(
      id,
      registration.walletAddress,
      registration.displayName
    );

    return {
      id,
      walletAddress: registration.walletAddress,
      tokenId: registration.tokenId,
      chainId: registration.chainId,
      displayName: registration.displayName || `Agent ${registration.tokenId}`,
      description: registration.description || '',
      avatarUrl: registration.avatarUrl || '',
      createdAt: new Date(now),
      isVerified,
      metadata: registration.metadata || {},
    };
  }

  /**
   * Get agent by ID
   */
  getAgent(agentId: string): Agent | null {
    const row = this.db
      .query('SELECT * FROM agents WHERE id = ?')
      .get(agentId) as Record<string, unknown> | null;

    if (!row) {
      return null;
    }

    return this.rowToAgent(row);
  }

  /**
   * Get agent by wallet address
   */
  getAgentByWallet(walletAddress: string): Agent | null {
    const row = this.db
      .query('SELECT * FROM agents WHERE wallet_address = ?')
      .get(walletAddress) as Record<string, unknown> | null;

    if (!row) {
      return null;
    }

    return this.rowToAgent(row);
  }

  /**
   * Get or create agent - used for auto-registration
   */
  async getOrCreateAgent(
    walletAddress: string,
    tokenId: number,
    chainId: number = 31337
  ): Promise<Agent> {
    const id = `agent-${chainId}-${tokenId}`;

    // Check by ID first
    let agent = this.getAgent(id);
    if (agent) {
      return agent;
    }

    // Check by wallet address
    agent = this.getAgentByWallet(walletAddress);
    if (agent) {
      return agent;
    }

    // Create new agent
    return await this.registerAgent({
      walletAddress,
      tokenId,
      chainId,
    });
  }

  /**
   * List all agents
   */
  listAgents(limit: number = 50, offset: number = 0): Agent[] {
    const rows = this.db
      .query('SELECT * FROM agents ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Record<string, unknown>[];

    return rows.map((row) => this.rowToAgent(row));
  }

  /**
   * Get total agent count
   */
  getAgentCount(): number {
    const result = this.db
      .query('SELECT COUNT(*) as count FROM agents')
      .get() as { count: number };
    return result?.count || 0;
  }

  /**
   * Discover agents matching criteria
   */
  discoverAgents(criteria: {
    verified?: boolean;
    search?: string;
    limit?: number;
  }): Agent[] {
    let query = 'SELECT * FROM agents WHERE 1=1';
    const params: (string | number)[] = [];

    if (criteria.verified !== undefined) {
      query += ' AND is_verified = ?';
      params.push(criteria.verified ? 1 : 0);
    }

    if (criteria.search) {
      query += ' AND (display_name LIKE ? OR description LIKE ?)';
      params.push(`%${criteria.search}%`, `%${criteria.search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(criteria.limit || 20);

    const rows = this.db.query(query).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.rowToAgent(row));
  }

  /**
   * Ensure user exists for social features
   */
  private async ensureUserExists(
    userId: string,
    walletAddress: string,
    displayName?: string
  ): Promise<void> {
    // Check by ID
    const existingById = this.db
      .query('SELECT id FROM users WHERE id = ?')
      .get(userId);
    if (existingById) {
      return;
    }

    // Check by wallet address
    const existingByWallet = this.db
      .query('SELECT id FROM users WHERE wallet_address = ?')
      .get(walletAddress);
    if (existingByWallet) {
      return;
    }

    const username = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.run(
      `
      INSERT INTO users (
        id, wallet_address, display_name, username, bio, virtual_balance, reputation_points
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      userId,
      walletAddress,
      displayName || `Agent ${userId.slice(-8)}`,
      username,
      'Autonomous agent on Babylon',
      1000,
      100
    );
  }

  private rowToAgent(row: Record<string, unknown>): Agent {
    return {
      id: row.id as string,
      walletAddress: row.wallet_address as string,
      tokenId: row.token_id as number,
      chainId: row.chain_id as number,
      displayName: row.display_name as string,
      description: row.description as string,
      avatarUrl: row.avatar_url as string,
      createdAt: new Date(row.created_at as string),
      isVerified: Boolean(row.is_verified),
      metadata: JSON.parse((row.metadata as string) || '{}'),
    };
  }
}
