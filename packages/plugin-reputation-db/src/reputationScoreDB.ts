import { Pool } from "pg";
import { Database } from "better-sqlite3";
import { ScoreProvider } from "./adapters/scoreProvider";
import { v4 as uuidv4 } from "uuid";

export class ReputationDB {
    private pool: Pool | null = null;
    private sqliteDb: Database | null = null;
    public adapters: Map<string, ScoreProvider> = new Map();

    constructor(connectionString?: string, providers: { [key: string]: ScoreProvider } = {}) {
        if (connectionString) {
            this.pool = new Pool({ connectionString });
        } else {
            const sqlite3 = require("better-sqlite3");
            this.sqliteDb = new sqlite3("reputation.db");
            this.initializeSqliteSchema();
        }

        // Register adapters
        Object.entries(providers).forEach(([key, adapter]) => {
            this.adapters.set(key, adapter);
        });
    }

    private initializeSqliteSchema() {
        if (!this.sqliteDb) return;

        console.log("Initializing SQLite schema...");
        this.sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS provider_mappings (
            provider TEXT NOT NULL,
            identifier TEXT NOT NULL,
            user_id TEXT NOT NULL,
            UNIQUE(provider, identifier),
            FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS scores (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            score REAL NOT NULL,
            last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, provider),
            FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );
    `);
        console.log("Schema initialized.");
    }


    private async getOrCreateUserId(provider: string, identifier: string): Promise<string> {
        // Step 1: Check if the user already exists
        const result = await this.query(
            `SELECT user_id FROM provider_mappings WHERE provider = ? AND identifier = ?`,
            [provider, identifier]
        );
        console.log("getOrCreateUserId result", result);

        if (result.rows.length > 0) {
            return result.rows[0].user_id;
        }

        // Step 2: If no existing user, create a new user_id
        await this.query(`INSERT INTO users (user_id) VALUES (?)`, [identifier]);

        // Step 3: Store the new provider mapping
        await this.query(
            `INSERT INTO provider_mappings (provider, identifier, user_id) VALUES (?, ?, ?)`,
            [provider, identifier, identifier]
        );
        console.log(
            "getOrCreateUserId step 3",
            "after adding record on provider_mappings table"
        );

        return identifier;
    }

    public async query(sql: string, params: any[] = []) {
        console.log("Executing SQL:", sql);
        console.log("With parameters:", params);

        if (this.pool) {
            return this.pool.query(sql, params);
        } else if (this.sqliteDb) {
            const stmt = this.sqliteDb.prepare(sql);
            if (sql.trim().toLowerCase().startsWith("select")) {
                return { rows: stmt.all(params) };
            } else {
                stmt.run(params);
                return { rows: [] };
            }
        }
        throw new Error("No database connection available");
    }

    async getScore(provider: string, identifier: string, refresh = false): Promise<number> {
        if (!this.adapters.has(provider)) {
            console.log('getScore()' , {
                adapters: this.adapters,
                provider,
            })
            throw new Error(`Provider ${provider} not registered`);
        }

        // Get or create a user_id
        const userId = await this.getOrCreateUserId(provider, identifier);

        if (!refresh) {
            const result = await this.query(
                `SELECT score FROM scores WHERE user_id = ? AND provider = ?`,
                [userId, provider]
            );

            if (result.rows.length > 0) {
                return result.rows[0].score; // ✅ Use cached score if available
            }
        }

        // Fetch new score from provider
        const adapter = this.adapters.get(provider)!;
        const score = await adapter.getScore(identifier, refresh);
        console.log("getScore", {
            score,
            provider,
            identifier,
        });

        // Store new score
        await this.query(
            `INSERT INTO scores (user_id, provider, score, last_updated)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, provider) DO UPDATE
        SET score = EXCLUDED.score, last_updated = CURRENT_TIMESTAMP`,
            [userId, provider, score]
        );

        return score;
    }

    async refreshScoresForUser(
        identifier: string,
        provider: string,
        providersToRefresh: string[] = []
    ) {
        const userId = await this.getOrCreateUserId(provider, identifier);
        console.log("refreshScoresForUser userId", userId);

        const result = await this.query(
            `SELECT provider, identifier FROM provider_mappings WHERE user_id = ?`,
            [userId]
        );
        console.log("refreshScoresForUser result", result);

        if (result.rows.length === 0) {
            console.warn(`No linked providers found for user ${userId}`);
            return;
        }

        const providersToUpdate =
            providersToRefresh.length > 0
                ? result.rows.filter((row) => providersToRefresh.includes(row.provider))
                : result.rows;

        for (const row of providersToUpdate) {
            console.log(
                `Refreshing score for provider: ${row.provider}, identifier: ${row.identifier}`
            );
            await this.getScore(row.provider, row.identifier, true);
        }
    }

    async linkUserAccounts(
        providerA: string,
        identifierA: string,
        providerB: string,
        identifierB: string
    ) {
        const userIdA = await this.getOrCreateUserId(providerA, identifierA);
        const userIdB = await this.getOrCreateUserId(providerB, identifierB);

        if (userIdA !== userIdB) {
            await this.query(
                `UPDATE provider_mappings SET user_id = ? WHERE user_id = ?`,
                [userIdA, userIdB]
            );

            await this.query(`DELETE FROM users WHERE user_id = ?`, [userIdB]);
        }
    }

    async closeConnection() {
        if (this.pool) {
            await this.pool.end();
        }
        if (this.sqliteDb) {
            this.sqliteDb.close();
        }
    }
}
