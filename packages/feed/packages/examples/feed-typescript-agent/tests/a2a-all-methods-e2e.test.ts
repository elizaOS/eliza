/**
 * Coverage E2E tests for the current FeedA2AClient surface
 * Tests against real server running on localhost:3000
 *
 * This suite exercises the methods the example client currently exposes and
 * explicitly logs where higher-level Feed operations are not wrapped yet.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import dotenv from "dotenv";
import { FeedA2AClient } from "../src/a2a-client";

dotenv.config({ path: ".env.local" });

const TEST_CONFIG = {
  baseUrl:
    process.env.FEED_API_URL?.replace("/api/a2a", "") ||
    "http://localhost:3000",
  address: process.env.AGENT0_ADDRESS || `0x${"1".repeat(40)}`,
  tokenId: Number.parseInt(process.env.AGENT0_TOKEN_ID || "999999", 10),
  privateKey: process.env.AGENT0_PRIVATE_KEY || `0x${"1".repeat(64)}`,
  apiKey: process.env.FEED_API_KEY || "test-api-key",
};

// Top-level await: evaluated before describe.skipIf() so the skip condition is correct
const serverAvailable = await (async () => {
  try {
    const r = await fetch("http://localhost:3000/api/health");
    return r.ok;
  } catch {
    return false;
  }
})();

if (!serverAvailable) {
  console.log(
    "⚠️  Feed server not running on :3000 — A2A coverage E2E tests will be skipped",
  );
}

describe.skipIf(!serverAvailable)("A2A Client Coverage E2E Tests", () => {
  let client: FeedA2AClient;

  beforeAll(async () => {
    // Check if server is running
    const healthCheck = await fetch("http://localhost:3000/api/health");
    if (!healthCheck.ok) {
      throw new Error(
        "Feed server must be running on localhost:3000. Run: bun run dev",
      );
    }

    client = new FeedA2AClient(TEST_CONFIG);
    await client.connect();
  });

  describe("Agent Discovery", () => {
    it("should discover agents (skipped - method not available)", async () => {
      console.log("⏭️  discoverAgents: Method not available in client");
    });

    it("should get agent info (skipped - method not available)", async () => {
      console.log("⏭️  getAgentInfo: Method not available in client");
    });
  });

  describe("Market Operations", () => {
    it("should get market data (skipped - method not available)", async () => {
      console.log("⏭️  getMarketData: Method not available in client");
    });

    it("should get market prices (skipped - method not available)", async () => {
      console.log("⏭️  getMarketPrices: Method not available in client");
    });

    it("should subscribe to market (skipped - method not available)", async () => {
      console.log("⏭️  subscribeMarket: Method not available in client");
    });

    it("should get predictions", async () => {
      const result = await client.getPredictions();
      expect(result).toHaveProperty("predictions");
      expect(Array.isArray(result.predictions)).toBe(true);
    });

    it("should get perpetuals", async () => {
      const result = await client.getPerpetuals();
      expect(result).toHaveProperty("perpetuals");
      expect(Array.isArray(result.perpetuals)).toBe(true);
    });

    it("should get trades (skipped - method not available)", async () => {
      console.log("⏭️  getTrades: Method not available in client");
    });

    it("should get trade history (skipped - method not available)", async () => {
      console.log("⏭️  getTradeHistory: Method not available in client");
    });
  });

  describe("Social Features", () => {
    it("should get feed", async () => {
      const result = await client.getFeed();
      expect(result).toHaveProperty("posts");
      expect(Array.isArray(result.posts)).toBe(true);
    });

    it("should get post (skipped - method not available)", async () => {
      console.log("⏭️  getPost: Method not available in client");
    });

    it("should get comments (skipped - method not available)", async () => {
      console.log("⏭️  getComments: Method not available in client");
    });

    it("should get trending tags", async () => {
      const result = await client.getTrendingTags();
      expect(result).toHaveProperty("tags");
      expect(Array.isArray(result.tags)).toBe(true);
    });

    it("should get posts by tag (skipped - method not available)", async () => {
      console.log("⏭️  getPostsByTag: Method not available in client");
    });
  });

  describe("User Management", () => {
    it("should get user profile", async () => {
      const result = await client.getUserProfile(client.agentId || "test-user");
      expect(result).toBeDefined();
    });

    it("should search users", async () => {
      const result = await client.searchUsers("test");
      expect(result).toHaveProperty("users");
      expect(Array.isArray(result.users)).toBe(true);
    });

    it("should get followers (skipped - method not available)", async () => {
      console.log("⏭️  getFollowers: Method not available in client");
    });

    it("should get following (skipped - method not available)", async () => {
      console.log("⏭️  getFollowing: Method not available in client");
    });
  });

  describe("Messaging", () => {
    it("should get chats", async () => {
      const result = await client.getChats();
      expect(result).toHaveProperty("chats");
      expect(Array.isArray(result.chats)).toBe(true);
    });

    it("should get unread count (skipped - method not available)", async () => {
      console.log("⏭️  getUnreadCount: Method not available in client");
    });

    it("should get group invites (skipped - method not available)", async () => {
      console.log("⏭️  getGroupInvites: Method not available in client");
    });
  });

  describe("Notifications", () => {
    it("should get notifications", async () => {
      const result = await client.getNotifications();
      expect(result).toHaveProperty("notifications");
      expect(Array.isArray(result.notifications)).toBe(true);
    });
  });

  describe("Stats & Discovery", () => {
    it("should get leaderboard", async () => {
      const result = await client.getLeaderboard();
      expect(result).toHaveProperty("leaderboard");
      expect(Array.isArray(result.leaderboard)).toBe(true);
    });

    it("should get system stats", async () => {
      const result = await client.getSystemStats();
      expect(result).toBeDefined();
    });

    // Referral methods are unavailable in this example client.
    // it('should get referrals', async () => {
    //   const result = await client.getReferrals();
    //   expect(result).toHaveProperty('referrals');
    //   expect(Array.isArray(result.referrals)).toBe(true);
    // });

    // it('should get referral stats', async () => {
    //   const result = await client.getReferralStats();
    //   expect(result).toBeDefined();
    // });

    // it('should get referral code', async () => {
    //   const result = await client.getReferralCode();
    //   expect(result).toHaveProperty('code');
    //   expect(result).toHaveProperty('url');
    // });

    it("should get reputation", async () => {
      const result = await client.getReputation();
      expect(result).toBeDefined();
    });

    it("should get organizations", async () => {
      const result = await client.getOrganizations();
      expect(result).toHaveProperty("organizations");
      expect(Array.isArray(result.organizations)).toBe(true);
    });
  });

  describe("Portfolio", () => {
    it("should get balance", async () => {
      const result = await client.getBalance();
      expect(result).toHaveProperty("balance");
      expect(typeof result.balance).toBe("number");
    });

    it("should get positions", async () => {
      const result = await client.getPositions();
      expect(result).toHaveProperty("perpPositions");
      expect(result).toHaveProperty("totalPnL");
    });

    it("should get user wallet (skipped - method not available)", async () => {
      console.log("⏭️  getUserWallet: Method not available in client");
    });
  });

  describe("x402 helpers", () => {
    it("should note that payment helpers are not exposed by FeedA2AClient", async () => {
      console.log(
        "⏭️  paymentRequest/paymentReceipt: not exposed by FeedA2AClient",
      );
    });
  });

  describe("Method Availability Check", () => {
    it("should expose the current domain methods exercised by this suite", () => {
      const expectedMethods = [
        // Market data
        "getPredictions",
        "getPerpetuals",
        // Social
        "getFeed",
        "getTrendingTags",
        // Users
        "getUserProfile",
        "searchUsers",
        // Portfolio
        "getBalance",
        "getPositions",
        // Messaging
        "getChats",
        // Notifications
        "getNotifications",
        // Stats
        "getLeaderboard",
        "getSystemStats",
        "getReputation",
        "getOrganizations",
      ];

      const missingMethods: string[] = [];

      expectedMethods.forEach((method) => {
        if (
          typeof (client as unknown as Record<string, unknown>)[method] !==
          "function"
        ) {
          missingMethods.push(method);
        }
      });

      if (missingMethods.length > 0) {
        console.error("❌ Missing methods:", missingMethods);
      }

      expect(missingMethods.length).toBe(0);
      expect(expectedMethods.length).toBe(14);
    });
  });
});
