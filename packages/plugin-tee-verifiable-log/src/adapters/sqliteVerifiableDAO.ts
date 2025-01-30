import type { Database } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
    type VerifiableLog,
    type VerifiableAgent,
    VerifiableDAO,
    type VerifiableLogQuery,
    type PageQuery,
} from "../types/logTypes.ts";

export class SQLite3VerifiableDAO extends VerifiableDAO<Database> {
    constructor(db: Database) {
        super();
        this.db = db;
        // load(db);
        // check if the tables exist, if not create them
        const tables = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('verifiable-logs', 'verifiable-agents');"
            )
            .all();
        if (tables.length !== 2) {
            this.initializeSchema();
        }
    }

    async initializeSchema(): Promise<void> {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS "tee_verifiable_logs"
            (
                "id"         TEXT PRIMARY KEY,
                "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "agent_id"   TEXT NOT NULL,
                "room_id"    TEXT NOT NULL,
                "user_id"    TEXT,
                "type"       TEXT,
                "content"    TEXT NOT NULL,
                "signature"  TEXT NOT NULL
            );
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS "tee_verifiable_agents"
            (
                "id"                    TEXT PRIMARY KEY,
                "created_at"            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                "agent_id"              TEXT NOT NULL,
                "agent_name"            TEXT,
                "agent_keypair_path"    TEXT NOT NULL,
                "agent_keypair_vlog_pk" TEXT NOT NULL,
                UNIQUE ("agent_id")
            );
        `);
    }

    async addLog(log: VerifiableLog): Promise<boolean> {
        const sql = `
            INSERT INTO "tee_verifiable_logs" ("id", "created_at", "agent_id", "room_id", "user_id", "type", "content",
                                           "signature")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `;
        try {
            this.db
                .prepare(sql)
                .run(
                    log.id || uuidv4(),
                    log.created_at || new Date().getTime(),
                    log.agent_id,
                    log.room_id,
                    log.user_id,
                    log.type,
                    log.content,
                    log.signature
                );
            return true;
        } catch (error) {
            console.error("SQLite3 Error adding log:", error);
            return false;
        }
    }

    async pageQueryLogs(
        query: VerifiableLogQuery,
        page: number,
        pageSize: number
    ): Promise<PageQuery<VerifiableLog[]>> {
        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (query.idEq) {
            conditions.push('id = ?');
            params.push(query.idEq);
        }
        if (query.agentIdEq) {
            conditions.push('agent_id = ?');
            params.push(query.agentIdEq);
        }
        if (query.roomIdEq) {
            conditions.push('room_id = ?');
            params.push(query.roomIdEq);
        }
        if (query.userIdEq) {
            conditions.push('user_id = ?');
            params.push(query.userIdEq);
        }
        if (query.typeEq) {
            conditions.push('type = ?');
            params.push(query.typeEq);
        }
        if (query.contLike) {
            conditions.push('content LIKE ?');
            params.push(`%${query.contLike}%`);
        }
        if (query.signatureEq) {
            conditions.push('signature = ?');
            params.push(query.signatureEq);
        }

        const whereClause =
            conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        let currentPage = page;  // Create a new variable instead of reassigning parameter
        if (currentPage < 1) {
            currentPage = 1;
        }
        const offset = (currentPage - 1) * pageSize;
        const limit = pageSize;


        try {
            const totalQuery = `SELECT COUNT(*) AS total
                                FROM tee_verifiable_logs ${whereClause}`;
            const stmt = this.db.prepare(totalQuery);
            const totalResult = stmt.get(params) as { total: number };
            const total = totalResult.total;

            const dataQuery = `
                SELECT *
                FROM tee_verifiable_logs ${whereClause}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            `;
            const dataResult = this.db
                .prepare(dataQuery)
                .all(...params, limit, offset);

            return {
                page: page,
                pageSize: pageSize,
                total: total,
                data: dataResult,
            } as PageQuery<VerifiableLog[]>;
        } catch (error) {
            console.error("Error querying tee_verifiable_logs:", error);
            throw error;
        }
    }

    async addAgent(agent: VerifiableAgent): Promise<boolean> {
        const sql = `
            INSERT INTO "tee_verifiable_agents" ("id", "created_at", "agent_id","agent_name","agent_keypair_path", "agent_keypair_vlog_pk")
            VALUES (?, ?, ?, ?, ?,?);
        `;
        try {
            this.db
                .prepare(sql)
                .run(
                    agent.id || uuidv4(),
                    agent.created_at || new Date().getTime(),
                    agent.agent_id,
                    agent.agent_name||"agent bot",
                    agent.agent_keypair_path,
                    agent.agent_keypair_vlog_pk
                );
            return true;
        } catch (error) {
            console.error("SQLite3 Error adding agent:", error);
            return false;
        }
    }

    async getAgent(agentId: string): Promise<VerifiableAgent> {
        const sql = `SELECT *
                     FROM "tee_verifiable_agents"
                     WHERE agent_id = ?`;
        try {
            const agent = this.db.prepare(sql).get(agentId);
            if (agent) {
                return agent as VerifiableAgent;
            }
            return null;
        } catch (error) {
            console.error("SQLite3 Error getting agent:", error);
            throw error;
        }
    }

    async listAgent(): Promise<VerifiableAgent[]> {
        const sql = `SELECT *
                     FROM "tee_verifiable_agents"`;
        try {
            const agents = this.db.prepare(sql).all();
            return agents as VerifiableAgent[];
        } catch (error) {
            console.error("SQLite3 Error listing agent:", error);
            throw error;
        }
    }
}
