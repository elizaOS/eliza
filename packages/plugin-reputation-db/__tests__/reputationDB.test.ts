import { ReputationDB } from "../src/reputationScoreDB";
import { TwitterAdapter } from "../src/adapters/twitterAdapter";
import { GivPowerAdapter } from "../src/adapters/givPowerAdapter";
import { MockAdapter } from "../src/adapters/mockAdapter";
import * as assert from "assert";

// jest.mock("better-sqlite3", () => {
//     return jest.fn().mockImplementation(() => {
//         return {
//             prepare: jest.fn().mockImplementation((sql) => ({
//                 all: jest.fn((params) => {
//                     console.log("Mocked all query:", sql, "With params:", params);
//                     return [];
//                 }),
//                 get: jest.fn((params) => {
//                     console.log("Mocked get query:", sql, "With params:", params);
//                     return null;
//                 }),
//                 run: jest.fn((params) => {
//                     console.log("Mocked run query:", sql, "With params:", params);
//                 }),
//             })),
//             exec: jest.fn(),
//             close: jest.fn(),
//         };
//     });
// });

const MOCK_SCORE = 80

jest.mock("../src/adapters/twitterAdapter", () => {
    return {
        TwitterAdapter: jest.fn().mockImplementation(() => {
            return {
                getScore: jest.fn().mockResolvedValue(MOCK_SCORE),
            };
        }),
    };
});

describe("ReputationDB with real SQLite DB", () => {
    let db: ReputationDB;
    let twitterAdapter: TwitterAdapter;
    let givPowerAdapter: GivPowerAdapter;
    let mockAdapter: MockAdapter;

    beforeAll(() => {
        // Initialize adapters
        twitterAdapter = new TwitterAdapter();
        givPowerAdapter = new GivPowerAdapter();
        mockAdapter = new MockAdapter();

        // Create a real SQLite DB in memory for testing
        db = new ReputationDB(undefined, {
            twitter: twitterAdapter,
            givPower: givPowerAdapter,
            mock: mockAdapter,
        });

        // Ensure schema is initialized
        db["initializeSqliteSchema"]();
    });

    afterEach(() => {
        if (db["sqliteDb"]) {
            db["sqliteDb"].exec(`
                DROP TABLE IF EXISTS scores;
                DROP TABLE IF EXISTS provider_mappings;
                DROP TABLE IF EXISTS users;
            `);
            db["initializeSqliteSchema"]();
        }
    });

    afterAll(async () => {
        // Close the SQLite connection after all tests
        await db.closeConnection();
    });

    test("Database schema should include required tables and columns", async () => {
        // Query table names
        const result = db["sqliteDb"]!.prepare(
            `SELECT name FROM sqlite_master WHERE type='table'`
        ).all() as { name: string }[];

        const tables = result.map((row) => row.name);
        expect(tables).toContain("users");
        expect(tables).toContain("user_provider_identifiers");
        expect(tables).toContain("scores");

        // Query column names for the "scores" table
        const scoresTableInfo = db["sqliteDb"]!.prepare(
            `PRAGMA table_info(scores)`
        ).all() as { name: string }[];

        const columnNames = scoresTableInfo.map((col) => col.name);
        expect(columnNames).toContain("user_id");
        expect(columnNames).toContain("provider");
        expect(columnNames).toContain("score");
    });


    test("Should create a new user and map Twitter handle", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({ rows: [] });

        const userId = await db["getOrCreateUserId"]("twitter", "example_handle");

        expect(userId).toBeDefined();
        expect(spyQuery).toHaveBeenCalledTimes(3); // Check, create user, map provider

        spyQuery.mockClear();
    });

    test("Should retrieve the same user_id for existing Twitter handle", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ user_id: "mock_user_id" }],
        });

        const userId = await db["getOrCreateUserId"]("twitter", "example_handle");

        expect(userId).toBe("mock_user_id");
        expect(spyQuery).toHaveBeenCalledTimes(1); // Only one lookup
        spyQuery.mockClear();
    });

    test("Should get Twitter score from cache if available", async () => {
        const spyQuery = jest.spyOn(db as any, "query");

        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBe(80);
        expect(spyQuery).toHaveBeenCalled();
        spyQuery.mockClear();
    });

    test("Should refresh Twitter score when requested", async () => {
        const spyAdapter = jest.spyOn(twitterAdapter, "getScore").mockResolvedValueOnce(95);
        const spyQuery = jest.spyOn(db as any, "query");

        const score = await db.getScore("twitter", "example_handle", true);

        expect(score).toBe(95);
        expect(spyAdapter).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalled();
        spyAdapter.mockClear();
        spyQuery.mockClear();
    });

    test("Should link multiple providers to the same user", async () => {
        const spyQuery = jest.spyOn(db as any, "query");

        await db.linkUserAccounts("twitter", "example_handle", "mainnet", "0xExampleWallet");

        expect(spyQuery).toHaveBeenCalled();
        spyQuery.mockClear();
    });

    test("Should refresh scores for multiple providers", async () => {
        const spyTwitter = jest.spyOn(twitterAdapter, "getScore").mockResolvedValueOnce(85);
        const spyGivPower = jest.spyOn(givPowerAdapter, "getScore").mockResolvedValueOnce(92);
        const spyQuery = jest.spyOn(db as any, "query");
        await db.getScore("twitter","example_handle", )
        await db.getScore("givPower", "example_handle")

        await db.refreshScoresForUser("example_handle", "twitter", ["twitter", "givPower"]);

        expect(spyTwitter).toHaveBeenCalled();
        expect(spyGivPower).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalled(); // Lookups + updates
        spyTwitter.mockClear();
        spyGivPower.mockClear();
        spyQuery.mockClear();
    });


    test("Should return correct score from database when available", async () => {
        const spyQuery = jest.spyOn(db as any, "query");

        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBe(MOCK_SCORE);
        expect(spyQuery).toHaveBeenCalled()
        spyQuery.mockClear();
    });

    test("Should not fetch from adapter if score exists in cache", async () => {
        // Spies to monitor `query` and `getScore` behavior
        const spyQuery = jest.spyOn(db as any, "query");
        const spyAdapter = jest.spyOn(twitterAdapter, "getScore");

        // First call: Should call the adapter and cache the result
        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBeDefined();
        expect(spyQuery).toHaveBeenCalled(); // Ensure DB query was called
        expect(spyAdapter).toHaveBeenCalled(); // Ensure adapter was called exactly once

        // Clear previous spy calls to isolate second call checks
        spyQuery.mockClear();
        spyAdapter.mockClear();

        // Second call: Should not call the adapter but use the cache
        const cachedScore = await db.getScore("twitter", "example_handle");
        expect(cachedScore).toBeDefined();
        expect(cachedScore).toBe(score); // Ensure the score matches the cached value

        // Assertions for second call
        expect(spyQuery).toHaveBeenCalled(); // Database might be queried to check cache
        expect(spyAdapter).not.toHaveBeenCalled(); // Adapter should NOT be called

        // Clean up mocks
        spyQuery.mockClear();
        spyAdapter.mockClear();
    });


    test("Should refresh all scores when requested", async () => {
        const spyTwitter = jest.spyOn(twitterAdapter, "getScore");
        const spyGivPower = jest.spyOn(givPowerAdapter, "getScore");
        const spyQuery = jest.spyOn(db as any, "query");

        await db.getScore('twitter','example_handle')
        await db.getScore('givPower', 'example_handle')
        await db.linkUserAccounts("twitter", 'example_handle', "givPower", "example_handle")

        spyTwitter.mockClear();
        spyGivPower.mockClear();

        await db.refreshScoresForUser("example_handle", "twitter", ["twitter", "givPower"]);

        expect(spyTwitter).toHaveBeenCalled();
        expect(spyGivPower).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalled();
        spyTwitter.mockClear();
        spyGivPower.mockClear();
        spyQuery.mockClear();
    });
});
