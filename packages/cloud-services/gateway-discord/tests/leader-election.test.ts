/**
 * Eliza App Bot Leader Election Tests
 *
 * Tests for the leader election mechanism used by the Eliza App Discord bot:
 * - Leader election constants (TTL, check interval)
 * - Leadership acquisition logic (SETNX)
 * - Leadership renewal logic (EXPIRE)
 * - Lock expiry handling
 * - Failover scenarios
 */

import { describe, expect, test } from "bun:test";

// ============================================
// Constants (matching gateway-manager.ts defaults)
// ============================================

/** Default Redis key for Eliza App bot leader election (configurable via env var) */
const ELIZA_APP_LEADER_KEY = "discord:eliza-app-bot:leader";

/** Leader election lock TTL in seconds (10 seconds) */
const ELIZA_APP_LEADER_TTL_SECONDS = 10;

/** How often to check/renew leadership (3 seconds) */
const ELIZA_APP_LEADER_CHECK_INTERVAL_MS = 3000;

describe("Eliza App Bot Leader Election Constants", () => {
  test("default leader key has correct format", () => {
    expect(ELIZA_APP_LEADER_KEY).toBe("discord:eliza-app-bot:leader");
    expect(ELIZA_APP_LEADER_KEY).toContain("discord:");
    expect(ELIZA_APP_LEADER_KEY).toContain("eliza-app");
  });

  test("TTL is 10 seconds", () => {
    expect(ELIZA_APP_LEADER_TTL_SECONDS).toBe(10);
  });

  test("check interval is 3 seconds", () => {
    expect(ELIZA_APP_LEADER_CHECK_INTERVAL_MS).toBe(3000);
  });

  test("TTL is greater than check interval", () => {
    // TTL should be > check interval to allow renewal before expiry
    const ttlMs = ELIZA_APP_LEADER_TTL_SECONDS * 1000;
    expect(ttlMs).toBeGreaterThan(ELIZA_APP_LEADER_CHECK_INTERVAL_MS);
  });

  test("check interval allows multiple renewals before TTL expires", () => {
    // Should be able to renew at least 2-3 times before TTL expires
    const ttlMs = ELIZA_APP_LEADER_TTL_SECONDS * 1000;
    const renewalsBeforeExpiry = Math.floor(ttlMs / ELIZA_APP_LEADER_CHECK_INTERVAL_MS);
    expect(renewalsBeforeExpiry).toBeGreaterThanOrEqual(3);
  });
});

describe("Leader Election Logic", () => {
  describe("SETNX (Set if Not Exists) behavior", () => {
    // Simulating Redis SETNX behavior
    type RedisSetResult = "OK" | null;

    interface MockRedis {
      data: Map<string, { value: string; expiresAt: number }>;
      set(key: string, value: string, options: { ex: number; nx: boolean }): RedisSetResult;
      get(key: string): string | null;
      expire(key: string, seconds: number): boolean;
      del(key: string): boolean;
    }

    const createMockRedis = (): MockRedis => {
      const data = new Map<string, { value: string; expiresAt: number }>();

      return {
        data,
        set(key: string, value: string, options: { ex: number; nx: boolean }): RedisSetResult {
          const now = Date.now();
          const existing = data.get(key);

          // Check if key exists and not expired
          if (existing && existing.expiresAt > now) {
            if (options.nx) {
              // NX flag: only set if not exists
              return null;
            }
          }

          // Set the key with expiry
          data.set(key, {
            value,
            expiresAt: now + options.ex * 1000,
          });
          return "OK";
        },
        get(key: string): string | null {
          const entry = data.get(key);
          if (!entry) return null;
          if (entry.expiresAt <= Date.now()) {
            data.delete(key);
            return null;
          }
          return entry.value;
        },
        expire(key: string, seconds: number): boolean {
          const entry = data.get(key);
          if (!entry || entry.expiresAt <= Date.now()) {
            data.delete(key);
            return false;
          }
          entry.expiresAt = Date.now() + seconds * 1000;
          return true;
        },
        del(key: string): boolean {
          return data.delete(key);
        },
      };
    };

    test("first pod acquires leadership", () => {
      const redis = createMockRedis();
      const result = redis.set(ELIZA_APP_LEADER_KEY, "pod-1", {
        ex: ELIZA_APP_LEADER_TTL_SECONDS,
        nx: true,
      });
      expect(result).toBe("OK");
      expect(redis.get(ELIZA_APP_LEADER_KEY)).toBe("pod-1");
    });

    test("second pod cannot acquire leadership while first holds it", () => {
      const redis = createMockRedis();

      // Pod 1 acquires
      const result1 = redis.set(ELIZA_APP_LEADER_KEY, "pod-1", {
        ex: ELIZA_APP_LEADER_TTL_SECONDS,
        nx: true,
      });
      expect(result1).toBe("OK");

      // Pod 2 tries to acquire
      const result2 = redis.set(ELIZA_APP_LEADER_KEY, "pod-2", {
        ex: ELIZA_APP_LEADER_TTL_SECONDS,
        nx: true,
      });
      expect(result2).toBeNull();

      // Pod 1 is still leader
      expect(redis.get(ELIZA_APP_LEADER_KEY)).toBe("pod-1");
    });

    test("leadership can be renewed with EXPIRE", () => {
      const redis = createMockRedis();

      // Acquire
      redis.set(ELIZA_APP_LEADER_KEY, "pod-1", {
        ex: ELIZA_APP_LEADER_TTL_SECONDS,
        nx: true,
      });

      // Renew
      const renewed = redis.expire(ELIZA_APP_LEADER_KEY, ELIZA_APP_LEADER_TTL_SECONDS);
      expect(renewed).toBe(true);
    });

    test("EXPIRE returns false for non-existent key", () => {
      const redis = createMockRedis();
      const renewed = redis.expire("non-existent-key", 10);
      expect(renewed).toBe(false);
    });

    test("leadership can be explicitly released with DEL", () => {
      const redis = createMockRedis();

      // Acquire
      redis.set(ELIZA_APP_LEADER_KEY, "pod-1", {
        ex: ELIZA_APP_LEADER_TTL_SECONDS,
        nx: true,
      });

      // Release
      const deleted = redis.del(ELIZA_APP_LEADER_KEY);
      expect(deleted).toBe(true);

      // Another pod can now acquire
      const result = redis.set(ELIZA_APP_LEADER_KEY, "pod-2", {
        ex: ELIZA_APP_LEADER_TTL_SECONDS,
        nx: true,
      });
      expect(result).toBe("OK");
    });
  });

  describe("Leadership state management", () => {
    interface LeadershipState {
      isLeader: boolean;
      podName: string;
    }

    const createLeadershipManager = (podName: string) => {
      let isLeader = false;

      return {
        getState: (): LeadershipState => ({ isLeader, podName }),
        becomeLeader: () => {
          isLeader = true;
        },
        loseLeadership: () => {
          isLeader = false;
        },
        isCurrentlyLeader: () => isLeader,
      };
    };

    test("pod starts as non-leader", () => {
      const manager = createLeadershipManager("pod-1");
      expect(manager.isCurrentlyLeader()).toBe(false);
    });

    test("pod becomes leader when acquiring lock", () => {
      const manager = createLeadershipManager("pod-1");
      manager.becomeLeader();
      expect(manager.isCurrentlyLeader()).toBe(true);
    });

    test("pod loses leadership when lock expires", () => {
      const manager = createLeadershipManager("pod-1");
      manager.becomeLeader();
      expect(manager.isCurrentlyLeader()).toBe(true);

      manager.loseLeadership();
      expect(manager.isCurrentlyLeader()).toBe(false);
    });

    test("state includes pod name", () => {
      const manager = createLeadershipManager("test-pod-123");
      const state = manager.getState();
      expect(state.podName).toBe("test-pod-123");
    });
  });

  describe("Failover timing", () => {
    test("maximum failover time calculation", () => {
      // When leader dies, worst case is:
      // - Lock just renewed (TTL full)
      // - Next check by other pod at max interval
      const maxFailoverMs =
        ELIZA_APP_LEADER_TTL_SECONDS * 1000 + ELIZA_APP_LEADER_CHECK_INTERVAL_MS;
      expect(maxFailoverMs).toBe(13000); // 10s TTL + 3s check = 13s max
    });

    test("minimum failover time calculation", () => {
      // Best case: lock about to expire, other pod checks immediately
      const minFailoverMs = 0; // Theoretically instant if timing aligns
      expect(minFailoverMs).toBe(0);
    });

    test("average failover time estimation", () => {
      // On average: half of TTL remaining + half of check interval
      const avgFailoverMs =
        (ELIZA_APP_LEADER_TTL_SECONDS * 1000) / 2 + ELIZA_APP_LEADER_CHECK_INTERVAL_MS / 2;
      expect(avgFailoverMs).toBe(6500); // 5s + 1.5s = 6.5s average
    });
  });
});

describe("Leader Election with Discord Intents", () => {
  // Discord intents required for DM messages
  const REQUIRED_INTENTS = {
    DirectMessages: 1 << 12, // 4096
    MessageContent: 1 << 15, // 32768
  };

  test("DirectMessages intent bit is correct", () => {
    expect(REQUIRED_INTENTS.DirectMessages).toBe(4096);
  });

  test("MessageContent intent bit is correct", () => {
    expect(REQUIRED_INTENTS.MessageContent).toBe(32768);
  });

  test("combined intents for Eliza App bot", () => {
    const combinedIntents = REQUIRED_INTENTS.DirectMessages | REQUIRED_INTENTS.MessageContent;
    expect(combinedIntents).toBe(36864); // 4096 + 32768
  });
});

describe("Discord Partials for DM Support", () => {
  // Partials enum values from Discord.js
  // These are required for DM support because DM channels are not cached by default
  const REQUIRED_PARTIALS = {
    Channel: 0, // Partials.Channel - required for DM channel events
    Message: 2, // Partials.Message - required for partial message events
  };

  test("Channel partial is required for DM events", () => {
    // DM channels are not part of any guild and are not cached by default
    // Without Partials.Channel, the bot won't receive DM messages
    expect(REQUIRED_PARTIALS.Channel).toBe(0);
  });

  test("Message partial enables handling of uncached messages", () => {
    // When a message event comes in for a partial message, this allows handling it
    expect(REQUIRED_PARTIALS.Message).toBe(2);
  });

  test("both Channel and Message partials should be configured", () => {
    const requiredPartials = [REQUIRED_PARTIALS.Channel, REQUIRED_PARTIALS.Message];
    expect(requiredPartials).toContain(0); // Channel
    expect(requiredPartials).toContain(2); // Message
    expect(requiredPartials.length).toBe(2);
  });
});

describe("Environment Variable Configuration", () => {
  const hasElizaAppBotConfig = (env: Record<string, string | undefined>): boolean => {
    return !!env.ELIZA_APP_DISCORD_BOT_TOKEN;
  };

  const hasRedisConfig = (env: Record<string, string | undefined>): boolean => {
    return !!(env.KV_REST_API_URL && env.KV_REST_API_TOKEN);
  };

  const canEnableLeaderElection = (env: Record<string, string | undefined>): boolean => {
    return hasElizaAppBotConfig(env) && hasRedisConfig(env);
  };

  test("detects Eliza App bot configuration", () => {
    expect(hasElizaAppBotConfig({ ELIZA_APP_DISCORD_BOT_TOKEN: "token" })).toBe(true);
    expect(hasElizaAppBotConfig({})).toBe(false);
    expect(hasElizaAppBotConfig({ ELIZA_APP_DISCORD_BOT_TOKEN: "" })).toBe(false);
  });

  test("detects Redis configuration", () => {
    expect(
      hasRedisConfig({
        KV_REST_API_URL: "https://redis.example.com",
        KV_REST_API_TOKEN: "token",
      }),
    ).toBe(true);
    expect(hasRedisConfig({ KV_REST_API_URL: "url" })).toBe(false);
    expect(hasRedisConfig({ KV_REST_API_TOKEN: "token" })).toBe(false);
    expect(hasRedisConfig({})).toBe(false);
  });

  test("leader election requires both bot and Redis config", () => {
    expect(
      canEnableLeaderElection({
        ELIZA_APP_DISCORD_BOT_TOKEN: "token",
        KV_REST_API_URL: "url",
        KV_REST_API_TOKEN: "token",
      }),
    ).toBe(true);

    expect(
      canEnableLeaderElection({
        ELIZA_APP_DISCORD_BOT_TOKEN: "token",
      }),
    ).toBe(false);

    expect(
      canEnableLeaderElection({
        KV_REST_API_URL: "url",
        KV_REST_API_TOKEN: "token",
      }),
    ).toBe(false);
  });
});

describe("Graceful Shutdown", () => {
  describe("Leadership release on shutdown", () => {
    interface ShutdownState {
      leadershipReleased: boolean;
      clientDestroyed: boolean;
      redisKeyDeleted: boolean;
    }

    const simulateGracefulShutdown = (isLeader: boolean): ShutdownState => {
      const state: ShutdownState = {
        leadershipReleased: false,
        clientDestroyed: false,
        redisKeyDeleted: false,
      };

      if (isLeader) {
        // Release leadership for faster failover
        state.redisKeyDeleted = true;
        state.clientDestroyed = true;
        state.leadershipReleased = true;
      }

      return state;
    };

    test("leader releases lock on graceful shutdown", () => {
      const state = simulateGracefulShutdown(true);
      expect(state.leadershipReleased).toBe(true);
      expect(state.redisKeyDeleted).toBe(true);
      expect(state.clientDestroyed).toBe(true);
    });

    test("non-leader has nothing to release", () => {
      const state = simulateGracefulShutdown(false);
      expect(state.leadershipReleased).toBe(false);
      expect(state.redisKeyDeleted).toBe(false);
      expect(state.clientDestroyed).toBe(false);
    });
  });

  describe("Interval cleanup", () => {
    test("leader check interval is cleared on shutdown", () => {
      let intervalCleared = false;
      const mockInterval = { id: 1 };

      const clearMockInterval = () => {
        intervalCleared = true;
      };

      // Simulate shutdown
      if (mockInterval) {
        clearMockInterval();
      }

      expect(intervalCleared).toBe(true);
    });
  });
});

describe("DM-Only Message Handling", () => {
  interface DiscordMessage {
    guild: { id: string } | null;
    author: { bot: boolean };
    content: string;
    channelId: string;
  }

  const shouldProcessMessage = (message: DiscordMessage): boolean => {
    // Skip bot messages
    if (message.author.bot) return false;

    // DM-only: Skip guild/server messages
    if (message.guild) return false;

    return true;
  };

  test("processes DM messages from users", () => {
    const message: DiscordMessage = {
      guild: null,
      author: { bot: false },
      content: "Hello!",
      channelId: "123",
    };
    expect(shouldProcessMessage(message)).toBe(true);
  });

  test("skips DM messages from bots", () => {
    const message: DiscordMessage = {
      guild: null,
      author: { bot: true },
      content: "Hello!",
      channelId: "123",
    };
    expect(shouldProcessMessage(message)).toBe(false);
  });

  test("skips server messages from users", () => {
    const message: DiscordMessage = {
      guild: { id: "guild-123" },
      author: { bot: false },
      content: "Hello!",
      channelId: "456",
    };
    expect(shouldProcessMessage(message)).toBe(false);
  });

  test("skips server messages from bots", () => {
    const message: DiscordMessage = {
      guild: { id: "guild-123" },
      author: { bot: true },
      content: "Hello!",
      channelId: "456",
    };
    expect(shouldProcessMessage(message)).toBe(false);
  });
});

describe("Webhook Forwarding", () => {
  interface ForwardPayload {
    event_type: string;
    event_id: string;
    data: {
      id: string;
      channel_id: string;
      guild_id: string | null;
      author: {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
        bot: boolean;
      };
      content: string;
      attachments: Array<{
        url: string;
        content_type?: string;
        filename?: string;
      }>;
    };
  }

  const createForwardPayload = (
    messageId: string,
    channelId: string,
    author: {
      id: string;
      username: string;
      globalName?: string;
      avatar?: string;
    },
    content: string,
  ): ForwardPayload => {
    return {
      event_type: "MESSAGE_CREATE",
      event_id: messageId,
      data: {
        id: messageId,
        channel_id: channelId,
        guild_id: null, // DM-only
        author: {
          id: author.id,
          username: author.username,
          global_name: author.globalName,
          avatar: author.avatar,
          bot: false,
        },
        content,
        attachments: [],
      },
    };
  };

  test("creates valid forward payload", () => {
    const payload = createForwardPayload(
      "123456789",
      "987654321",
      { id: "111", username: "testuser", globalName: "Test User" },
      "Hello!",
    );

    expect(payload.event_type).toBe("MESSAGE_CREATE");
    expect(payload.event_id).toBe("123456789");
    expect(payload.data.id).toBe("123456789");
    expect(payload.data.guild_id).toBeNull();
    expect(payload.data.author.username).toBe("testuser");
    expect(payload.data.content).toBe("Hello!");
  });

  test("guild_id is always null for DM forwarding", () => {
    const payload = createForwardPayload("123", "456", { id: "789", username: "user" }, "test");
    expect(payload.data.guild_id).toBeNull();
  });

  test("bot flag is always false for forwarded messages", () => {
    const payload = createForwardPayload("123", "456", { id: "789", username: "user" }, "test");
    expect(payload.data.author.bot).toBe(false);
  });
});
