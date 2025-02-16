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
        -- Users table: Stores unique internal user IDs
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY, -- Internal unique user identifier (UUID)
            created_at TEXT DEFAULT CURRENT_TIMESTAMP -- Timestamp of user creation
        );

        -- User-provider mappings table: Links users to provider-specific identifiers
        CREATE TABLE IF NOT EXISTS user_provider_identifiers (
            identifier TEXT NOT NULL, -- Provider-specific identifier (e.g., Twitter username)
            user_id TEXT NOT NULL, -- Internal user ID (foreign key to users table)
            provider TEXT NOT NULL, -- Name of the provider (e.g., 'twitter', 'github')
            PRIMARY KEY(user_id, provider), -- Ensure unique mapping for each user-provider pair
            UNIQUE(provider, identifier), -- Ensure unique provider-identifier pair
            FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE -- Cascade delete on user removal
        );

        -- Scores table: Stores scores for each user-provider combination
        CREATE TABLE IF NOT EXISTS scores (
            id TEXT PRIMARY KEY, -- Unique score entry ID
            user_id TEXT NOT NULL, -- Internal user ID (foreign key to users table)
            provider TEXT NOT NULL, -- Provider name
            score REAL NOT NULL, -- Numeric score value
            last_updated TEXT DEFAULT CURRENT_TIMESTAMP, -- Timestamp of the last score update
            UNIQUE(user_id, provider), -- Ensure only one score per user-provider pair
            FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE -- Cascade delete on user removal
        );
    `);
        console.log("Schema initialized.");
    }

    // Get or create a user ID for a given provider and identifier
    private async getOrCreateUserId(provider: string, identifier: string): Promise<string> {
        // Step 1: Check if the user already exists in user_provider_identifiers
        const result = await this.query(
            `SELECT user_id FROM user_provider_identifiers WHERE provider = ? AND identifier = ?`,
            [provider, identifier]
        );

        if (result.rows.length > 0) {
            console.log("User exists:", result.rows);
            return result.rows[0].user_id; // User exists, return the user ID
        }

        // Step 2: Create a new user
        const userId = uuidv4(); // Generate a new unique user ID
        await this.query(`INSERT INTO users (user_id) VALUES (?)`, [userId]);

        // Step 3: Link the new user to the provider and identifier
        await this.query(
            `INSERT INTO user_provider_identifiers (identifier, user_id, provider) VALUES (?, ?, ?)`,
            [identifier, userId, provider]
        );

        return userId;
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
            throw new Error(`Provider ${provider} not registered`);
        }

        // Get or create a user_id
        const userId = await this.getOrCreateUserId(provider, identifier);
        console.log('getScore()', {
            userId,
            identifier,
            provider
        })

        if (!refresh) {
            const result = await this.query(
                `SELECT score FROM scores WHERE user_id = ? AND provider = ?`,
                [userId, provider]
            );

            if (result.rows.length > 0) {
                return result.rows[0].score; // Use cached score if available
            }
        }

        // Fetch new score from the provider adapter
        const adapter = this.adapters.get(provider)!;
        const score = await adapter.getScore(identifier, refresh);

        console.log('getScore() before insertion', {
            score,
            provider,
            identifier
        })
        // Store the new score in the database
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

        const result = await this.query(
            `SELECT provider, identifier FROM user_provider_identifiers WHERE user_id = ?`,
            [userId]
        );

        if (result.rows.length === 0) {
            console.warn(`No linked providers found for user ${userId}`);
            return;
        }
        const providersToUpdate =
            providersToRefresh.length > 0
                ? result.rows.filter((row) => providersToRefresh.includes(row.provider))
                : result.rows;

        console.log(`Refreshing scores for user ${userId}:`, providersToUpdate)
        for (const row of providersToUpdate) {
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
                `UPDATE user_provider_identifiers SET user_id = ? WHERE user_id = ?`,
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
