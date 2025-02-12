import type { Database } from 'better-sqlite3';
import {
    TeeLogDAO,
    type TeeAgent,
    type TeeLog,
    type TeeLogQuery,
    type TeePageQuery,
} from '../types.ts';
import { sqliteTables } from './sqliteTables.ts';

export class SqliteTeeLogDAO extends TeeLogDAO {
    constructor(db: Database) {
        super();
        this.db = db;
    }

    async initialize(): Promise<void> {
        this.db.exec(sqliteTables);
    }

    async addLog(log: TeeLog): Promise<boolean> {
        const stmt = this.db.prepare(
            'INSERT INTO tee_logs (id, agentId, roomId, userId, type, content, timestamp, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        );
        try {
            stmt.run(
                log.id,
                log.agentId,
                log.roomId,
                log.userId,
                log.type,
                log.content,
                log.timestamp,
                log.signature,
            );
            return true;
        } catch (error) {
            console.error('Error adding log to database', error);
            return false;
        }
    }

    async getPagedLogs(
        query: TeeLogQuery,
        page: number,
        pageSize: number,
    ): Promise<TeePageQuery<TeeLog[]>> {
        if (page < 1) {
            page = 1;
        }
        const offset = (page - 1) * pageSize;
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
        if (query.userId && query.userId !== '') {
            whereConditions.push('userId = ?');
            params.push(query.userId);
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

        const whereClause =
            whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

        try {
            const total_stmt = this.db.prepare(
                `SELECT COUNT(*) as total FROM tee_logs ${whereClause}`,
            );
            const total = total_stmt.get(params).total;

            const logs_stmt = this.db.prepare(
                `SELECT * FROM tee_logs ${whereClause} ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
            );
            const logs = logs_stmt.all(...params, limit, offset);

            return {
                page,
                pageSize,
                total,
                data: logs,
            };
        } catch (error) {
            console.error('Error getting paged logs from database', error);
            throw error;
        }
    }

    async addAgent(agent: TeeAgent): Promise<boolean> {
        const stmt = this.db.prepare(
            'INSERT INTO tee_agents (id, agentId, agentName, createdAt, publicKey, attestation) VALUES (?, ?, ?, ?, ?, ?)',
        );
        try {
            stmt.run(
                agent.id,
                agent.agentId,
                agent.agentName,
                agent.createdAt,
                agent.publicKey,
                agent.attestation,
            );
            return true;
        } catch (error) {
            console.error('Error adding agent to database', error);
            return false;
        }
    }

    async getAgent(agentId: string): Promise<TeeAgent | null> {
        const stmt = this.db.prepare(
            'SELECT * FROM tee_agents WHERE agentId = ? ORDER BY createdAt DESC LIMIT 1',
        );
        try {
            return stmt.get(agentId);
        } catch (error) {
            console.error('Error getting agent from database', error);
            throw error;
        }
    }

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
