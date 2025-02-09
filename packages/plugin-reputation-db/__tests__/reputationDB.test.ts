import { ReputationDB } from "../src/reputationScoreDB";
import { TwitterAdapter } from "../src/adapters/twitterAdapter";
import { GivPowerAdapter } from "../src/adapters/givPowerAdapter";
import { MockAdapter } from "../src/adapters/mockAdapter";

// jest.mock("better-sqlite3", () => {
//     return jest.fn().mockImplementation(() => {
//         return {
//             prepare: () => ({
//                 all: jest.fn().mockReturnValue([]),
//                 get: jest.fn().mockReturnValue(null),
//                 run: jest.fn(),
//             }),
//             exec: jest.fn(),
//             close: jest.fn(),
//         };
//     });
// });

jest.mock("../src/adapters/twitterAdapter", () => {
    return {
        TwitterAdapter: jest.fn().mockImplementation(() => {
            return {
                getScore: jest.fn().mockResolvedValue(80), // Fixed value instead of random
            };
        }),
    };
});


describe("ReputationDB", () => {
    let db: ReputationDB;
    let twitterAdapter: TwitterAdapter;
    let givPowerAdapter: GivPowerAdapter;
    let mockAdapter: MockAdapter;

    beforeAll(() => {
        twitterAdapter = new TwitterAdapter();
        givPowerAdapter = new GivPowerAdapter();
        mockAdapter = new MockAdapter();

        db = new ReputationDB(undefined, {
            twitter: twitterAdapter,
            givPower: givPowerAdapter,
            mock: mockAdapter,
        });
    });

    test("Should create a new user and map Twitter handle", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({ rows: [] }); // No existing user

        const userId = await db["getOrCreateUserId"]("twitter", "example_handle");

        expect(userId).toBeDefined();
        expect(spyQuery).toHaveBeenCalledTimes(3); // 1 for checking, 1 for user creation, 1 for mapping

        spyQuery.mockRestore();
    });

    test("Should retrieve the same user_id for existing Twitter handle", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ user_id: "mock_user_id" }],
        });

        const userId = await db["getOrCreateUserId"]("twitter", "example_handle");

        expect(userId).toBe("mock_user_id");
        expect(spyQuery).toHaveBeenCalledTimes(1); // No extra inserts
        spyQuery.mockRestore();
    });

    test("Should get Twitter score from cache if available", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ score: 80 }],
        });

        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBe(80);
        expect(spyQuery).toHaveBeenCalledTimes(3); // Includes fetch user, check db, save to db
        spyQuery.mockRestore();
    });

    test("Should refresh Twitter score when requested", async () => {
        const spyAdapter = jest.spyOn(twitterAdapter, "getScore").mockResolvedValueOnce(95);
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({ rows: [] });

        const score = await db.getScore("twitter", "example_handle", true);

        expect(score).toBe(95);
        expect(spyAdapter).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalledTimes(4); // 1 for user_id, 1 for select, 1 for insert/update

        spyAdapter.mockRestore();
        spyQuery.mockRestore();
    });

    test("Should link multiple providers to the same user", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ user_id: "mock_user_id" }],
        });

        await db.linkUserAccounts("twitter", "example_handle", "mainnet", "0xExampleWallet");

        expect(spyQuery).toHaveBeenCalled(); // 2 user_id lookups, 1 update, 1 delete (if merging)
        spyQuery.mockRestore();
    });

    test.only("Should refresh scores for multiple providers", async () => {
        const spyTwitter = jest.spyOn(twitterAdapter, "getScore").mockResolvedValueOnce(85);
        const spyGivPower = jest.spyOn(givPowerAdapter, "getScore").mockResolvedValueOnce(92);
        const spyQuery = jest.spyOn(db as any, "query")

        await db.refreshScoresForUser("example_handle", "twitter",["twitter", "givPower"]);

        expect(spyTwitter).toHaveBeenCalled();
        expect(spyGivPower).toHaveBeenCalled();
        expect(spyQuery).toHaveBeenCalled(); // 2 user_id lookups + 2 inserts + 1 select

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
        expect(spyQuery).toHaveBeenCalledTimes(3); // 1 user_id lookup, 1 select, 1 insert/update

        spyGitcoin.mockRestore();
        spyQuery.mockRestore();
    });

    test("Should return correct score from database when available", async () => {
        const spyQuery = jest.spyOn(db as any, "query").mockResolvedValueOnce({
            rows: [{ score: 90 }],
        });

        const score = await db.getScore("twitter", "example_handle");
        expect(score).toBe(90);
        expect(spyQuery).toHaveBeenCalledTimes(2);
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

        await db.refreshScoresForUser( "example_handle", "twitter", ["twitter", "givPower"]);

        expect(spyTwitter).toHaveBeenCalled();
        expect(spyGivPower).toHaveBeenCalledTimes(0);
        expect(spyQuery).toHaveBeenCalledTimes(5);

        spyTwitter.mockRestore();
        spyGivPower.mockRestore();
        spyQuery.mockRestore();
    });

});
