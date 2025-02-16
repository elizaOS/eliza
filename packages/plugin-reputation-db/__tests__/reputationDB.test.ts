import { ReputationDB } from "../src/reputationScoreDB";
import { TwitterAdapter } from "../src/adapters/twitterAdapter";
import { GivPowerAdapter } from "../src/adapters/givPowerAdapter";
import { MockAdapter } from "../src/adapters/mockAdapter";

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

jest.mock("../src/adapters/twitterAdapter", () => {
    return {
        TwitterAdapter: jest.fn().mockImplementation(() => {
            return {
                getScore: jest.fn().mockResolvedValue(80),
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

    test.only("Database schema should include required tables and columns", async () => {
        // Query table names
        const result = db["sqliteDb"]!.prepare(
            `SELECT name FROM sqlite_master WHERE type='table'`
        ).all() as { name: string }[];

        const tables = result.map((row) => row.name);
        expect(tables).toContain("users");
        expect(tables).toContain("provider_mappings");
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

        spyQuery.mockRestore();
    });

    test("Should retrieve the same user_id for existing Twitter handle", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ user_id: "mock_user_id" }],
        });

        const userId = await db["getOrCreateUserId"]("twitter", "example_handle");

        expect(userId).toBe("mock_user_id");
        expect(spyQuery).toHaveBeenCalledTimes(1); // Only one lookup
        spyQuery.mockRestore();
    });

    test("Should get Twitter score from cache if available", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ score: 80 }],
        });

        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBe(80);
        expect(spyQuery).toHaveBeenCalledTimes(3); // Fetch user, check DB, save
        spyQuery.mockRestore();
    });

    test("Should refresh Twitter score when requested", async () => {
        const spyAdapter = jest.spyOn(twitterAdapter, "getScore").mockResolvedValueOnce(95);
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({ rows: [] });

        const score = await db.getScore("twitter", "example_handle", true);

        expect(score).toBe(95);
        expect(spyAdapter).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalledTimes(4); // Check user, query DB, update
        spyAdapter.mockRestore();
        spyQuery.mockRestore();
    });

    test("Should link multiple providers to the same user", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ user_id: "mock_user_id" }],
        });

        await db.linkUserAccounts("twitter", "example_handle", "mainnet", "0xExampleWallet");

        expect(spyQuery).toHaveBeenCalledTimes(4); // 2 lookups, 1 update, 1 delete
        spyQuery.mockRestore();
    });

    test.only("Should refresh scores for multiple providers", async () => {
        const spyTwitter = jest.spyOn(twitterAdapter, "getScore").mockResolvedValueOnce(85);
        const spyGivPower = jest.spyOn(givPowerAdapter, "getScore").mockResolvedValueOnce(92);
        const spyQuery = jest.spyOn(db as any, "query");
        await db.getScore("twitter","example_handle", )
        await db.getScore("givPower", "example_handle")

        await db.refreshScoresForUser("example_handle", "twitter", ["twitter", "givPower"]);

        expect(spyTwitter).toHaveBeenCalled();
        expect(spyGivPower).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalled(); // Lookups + updates
        spyTwitter.mockRestore();
        spyGivPower.mockRestore();
        spyQuery.mockRestore();
    });

    test("Should refresh a newly added provider (Gitcoin)", async () => {
        const spyGitcoin = jest.spyOn(mockAdapter, "getScore").mockResolvedValueOnce(100);
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({ rows: [] });

        const score = await db.getScore("gitcoin", "gitcoin_user_123", true);

        expect(score).toBe(100);
        expect(spyGitcoin).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalledTimes(3); // Lookup + insert/update
        spyGitcoin.mockRestore();
        spyQuery.mockRestore();
    });

    test("Should return correct score from database when available", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ score: 90 }],
        });

        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBe(90);
        expect(spyQuery).toHaveBeenCalledTimes(2); // Check DB + return
        spyQuery.mockRestore();
    });

    test("Should not fetch from adapter if score exists in cache", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ score: 70 }],
        });
        const spyAdapter = jest.spyOn(twitterAdapter, "getScore");

        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBe(70);
        expect(spyQuery).toHaveBeenCalledTimes(2);
        expect(spyAdapter).not.toHaveBeenCalled();
        spyQuery.mockRestore();
        spyAdapter.mockRestore();
    });

    test("Should refresh all scores when requested", async () => {
        const spyTwitter = jest.spyOn(twitterAdapter, "getScore").mockResolvedValueOnce(85);
        const spyGivPower = jest.spyOn(givPowerAdapter, "getScore").mockResolvedValueOnce(92);
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({ rows: [] });

        await db.refreshScoresForUser("example_handle", "twitter", ["twitter", "givPower"]);

        expect(spyTwitter).toHaveBeenCalled();
        expect(spyGivPower).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalled();
        spyTwitter.mockRestore();
        spyGivPower.mockRestore();
        spyQuery.mockRestore();
    });
});
