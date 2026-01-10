// packages/plugin-twitter/src/tests/ClientBaseTestSuite.ts

import type { TestSuite } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import type { TwitterConfig } from "./environment";
import { ClientBase } from "./base";

/**
 * Test suite for Twitter client base functionality
 */
export class ClientBaseTestSuite implements TestSuite {
  name = "twitter-client-base";

  private mockRuntime: IAgentRuntime;
  private mockConfig: TwitterConfig;

  constructor() {
    // Create a mock runtime for tests
    this.mockRuntime = {
      agentId: "test-agent-id" as any,
      getSetting: (key: string) => {
        return this.mockConfig[key];
      },
      character: {},
      getCache: async () => null,
      setCache: async () => {},
      getMemoriesByRoomIds: async () => [],
      ensureWorldExists: async () => {},
      ensureConnection: async () => {},
      createMemory: async () => {},
      getEntityById: async () => null,
      updateEntity: async () => {},
    } as any;

    // Create test config with only API v2 credentials
    this.mockConfig = {
      TWITTER_API_KEY: "test-api-key",
      TWITTER_API_SECRET_KEY: "test-api-secret",
      TWITTER_ACCESS_TOKEN: "test-access-token",
      TWITTER_ACCESS_TOKEN_SECRET: "test-access-secret",
      TWITTER_DRY_RUN: "false",
      TWITTER_TARGET_USERS: "",
      TWITTER_ENABLE_POST: "false",
      TWITTER_ENABLE_REPLIES: "true",
      TWITTER_ENABLE_ACTIONS: "false",
      TWITTER_POST_INTERVAL: "120",
      TWITTER_ENGAGEMENT_INTERVAL: "30",
      TWITTER_MAX_ENGAGEMENTS_PER_RUN: "10",
      TWITTER_MAX_TWEET_LENGTH: "280",
      TWITTER_RETRY_LIMIT: "5",
    };
  }

  tests = [
    {
      name: "Initialize client with API v2 credentials",
      fn: async () => {
        const state = {
          TWITTER_API_KEY: this.mockConfig.TWITTER_API_KEY,
          TWITTER_API_SECRET_KEY: this.mockConfig.TWITTER_API_SECRET_KEY,
          TWITTER_ACCESS_TOKEN: this.mockConfig.TWITTER_ACCESS_TOKEN,
          TWITTER_ACCESS_TOKEN_SECRET:
            this.mockConfig.TWITTER_ACCESS_TOKEN_SECRET,
        };
        const client = new ClientBase(this.mockRuntime, state);

        // The client should initialize without throwing
        if (!client) {
          throw new Error("Client initialization failed");
        }

        // The v2 client should be available
        if (!client.twitterClient) {
          throw new Error("Twitter v2 client not initialized");
        }
      },
    },

    {
      name: "Initialize without API Key should throw",
      fn: async () => {
        const state = {
          // Missing TWITTER_API_KEY
          TWITTER_API_SECRET_KEY: this.mockConfig.TWITTER_API_SECRET_KEY,
          TWITTER_ACCESS_TOKEN: this.mockConfig.TWITTER_ACCESS_TOKEN,
          TWITTER_ACCESS_TOKEN_SECRET:
            this.mockConfig.TWITTER_ACCESS_TOKEN_SECRET,
        };

        try {
          new ClientBase(this.mockRuntime, state);
          throw new Error("Should have thrown error for missing API key");
        } catch (error) {
          // Expected to throw
        }
      },
    },

    {
      name: "Initialize with dry run mode",
      fn: async () => {
        const state = {
          TWITTER_API_KEY: this.mockConfig.TWITTER_API_KEY,
          TWITTER_API_SECRET_KEY: this.mockConfig.TWITTER_API_SECRET_KEY,
          TWITTER_ACCESS_TOKEN: this.mockConfig.TWITTER_ACCESS_TOKEN,
          TWITTER_ACCESS_TOKEN_SECRET:
            this.mockConfig.TWITTER_ACCESS_TOKEN_SECRET,
          TWITTER_DRY_RUN: "true",
        };
        const client = new ClientBase(this.mockRuntime, state);

        // Client should initialize in dry run mode
        if (!client.state.TWITTER_DRY_RUN) {
          throw new Error("Client not in dry run mode");
        }
      },
    },

    {
      name: "Initialize with correct intervals",
      fn: async () => {
        const state = {
          TWITTER_API_KEY: this.mockConfig.TWITTER_API_KEY,
          TWITTER_API_SECRET_KEY: this.mockConfig.TWITTER_API_SECRET_KEY,
          TWITTER_ACCESS_TOKEN: this.mockConfig.TWITTER_ACCESS_TOKEN,
          TWITTER_ACCESS_TOKEN_SECRET:
            this.mockConfig.TWITTER_ACCESS_TOKEN_SECRET,
          TWITTER_POST_INTERVAL: "180",
          TWITTER_ENGAGEMENT_INTERVAL: "45",
        };
        const client = new ClientBase(this.mockRuntime, state);

        // Verify intervals are set correctly
        if (client.state.TWITTER_POST_INTERVAL !== "180") {
          throw new Error("Client state TWITTER_POST_INTERVAL mismatch.");
        }
        if (client.state.TWITTER_ENGAGEMENT_INTERVAL !== "45") {
          throw new Error("Client state TWITTER_ENGAGEMENT_INTERVAL mismatch.");
        }
      },
    },
  ];
}
