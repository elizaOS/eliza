import type { Database } from 'better-sqlite3';
import {
  type TeeAgent,
  type TeeLog,
  TeeLogDAO,
  type TeeLogQuery,
  type TeePageQuery,
} from '../types';
import { sqliteTables } from './sqliteTables';

/**
 * Represents a data access object for interacting with SQLite database to perform operations related to TeeLog and TeeAgent.
 * @extends TeeLogDAO
 */
export class SqliteTeeLogDAO extends TeeLogDAO<Database> {
  /**
   * Constructor for creating a new instance of the class.
   * @param {Database} db - The database object to be used by the instance
   */
  constructor(db: Database) {
    super();
    this.db = db;
  }

  /**
   * Asynchronously initializes the database by executing the provided SQLite table creation SQL.
   * @returns A Promise that resolves to void once the initialization is complete.
   */
  async initialize(): Promise<void> {
    this.db.exec(sqliteTables);
  }

  /**
   * Add a log to the database.
   *
   * @param {TeeLog} log - The log object to be added.
   * @returns {Promise<boolean>} - Indicates if the log was successfully added or not.
   */
  async addLog(log: TeeLog): Promise<boolean> {
    const stmt = this.db.prepare(
      'INSERT INTO tee_logs (id, agentId, roomId, entityId, type, content, timestamp, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    try {
      stmt.run(
        log.id,
        log.agentId,
        log.roomId,
        log.entityId,
        log.type,
        log.content,
        log.timestamp,
        log.signature
      );
      return true;
    } catch (error) {
      console.error('Error adding log to database', error);
      return false;
    }
  }

  /**
   * Retrieves paged logs based on the provided query criteria.
   *
   * @param {TeeLogQuery} query - The query criteria to filter the logs.
   * @param {number} page - The page number to retrieve.
   * @param {number} pageSize - The number of logs per page.
   * @returns {Promise<TeePageQuery<TeeLog[]>>} The paged logs data along with page information.
   */
  async getPagedLogs(
    query: TeeLogQuery,
    page: number,
    pageSize: number
  ): Promise<TeePageQuery<TeeLog[]>> {
    const currentPage = page < 1 ? 1 : page;
    const offset = (currentPage - 1) * pageSize;
    const limit = pageSize;

    const whereConditions = [];
    const params = [];

    if (query.agentId && query.agentId !== '') {
      whereConditions.push('agentId = ?');
      params.push(query.agentId);
    }
    if (query.roomId && query.roomId !== '') {
      whereConditions.push('roomId = ?');
      params.push(query.roomId);
    }
    if (query.entityId && query.entityId !== '') {
      whereConditions.push('entityId = ?');
      params.push(query.entityId);
    }
    if (query.type && query.type !== '') {
      whereConditions.push('type = ?');
      params.push(query.type);
    }
    if (query.containsContent && query.containsContent !== '') {
      whereConditions.push('content LIKE ?');
      params.push(`%${query.containsContent}%`);
    }
    if (query.startTimestamp) {
      whereConditions.push('timestamp >= ?');
      params.push(query.startTimestamp);
    }
    if (query.endTimestamp) {
      whereConditions.push('timestamp <= ?');
      params.push(query.endTimestamp);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    try {
      const total_stmt = this.db.prepare(`SELECT COUNT(*) as total FROM tee_logs ${whereClause}`);
      const total = total_stmt.get(params).total;

      const logs_stmt = this.db.prepare(
        `SELECT * FROM tee_logs ${whereClause} ORDER BY timestamp ASC LIMIT ? OFFSET ?`
      );
      const logs = logs_stmt.all(...params, limit, offset);

      return {
        page: currentPage,
        pageSize,
        total,
        data: logs,
      };
    } catch (error) {
      console.error('Error getting paged logs from database', error);
      throw error;
    }
  }

  /**
   * Add an agent to the database.
   *
   * @param {TeeAgent} agent - The TeeAgent object to be added.
   * @returns {Promise<boolean>} - A Promise that resolves to true if the agent was successfully added, and false otherwise.
   */
  async addAgent(agent: TeeAgent): Promise<boolean> {
    const stmt = this.db.prepare(
      'INSERT INTO tee_agents (id, agentId, agentName, createdAt, publicKey, attestation) VALUES (?, ?, ?, ?, ?, ?)'
    );
    try {
      stmt.run(
        agent.id,
        agent.agentId,
        agent.agentName,
        agent.createdAt,
        agent.publicKey,
        agent.attestation
      );
      return true;
    } catch (error) {
      console.error('Error adding agent to database', error);
      return false;
    }
  }

  /**
   * Retrieves a TeeAgent from the database based on the provided agentId.
   *
   * @param {string} agentId - The unique identifier of the agent to retrieve.
   * @returns {Promise<TeeAgent | null>} A promise that resolves with the retrieved TeeAgent, or null if not found.
   */
  async getAgent(agentId: string): Promise<TeeAgent | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM tee_agents WHERE agentId = ? ORDER BY createdAt DESC LIMIT 1'
    );
    try {
      return stmt.get(agentId);
    } catch (error) {
      console.error('Error getting agent from database', error);
      throw error;
    }
  }

  /**
   * Retrieves all agents from the database.
   *
   * @returns {Promise<TeeAgent[]>} All agents
   */
  async getAllAgents(): Promise<TeeAgent[]> {
    const stmt = this.db.prepare('SELECT * FROM tee_agents');
    try {
      return stmt.all();
    } catch (error) {
      console.error('Error getting all agents from database', error);
      throw error;
    }
  }
}
