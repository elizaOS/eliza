import { TwitterApi } from "twitter-api-v2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TwitterAuth } from "../auth";

// Mock twitter-api-v2
vi.mock("twitter-api-v2", () => ({
  TwitterApi: vi.fn().mockImplementation(() => ({
    v2: {
      me: vi.fn(),
    },
  })),
}));

describe("TwitterAuth", () => {
  let auth: TwitterAuth;
  let mockTwitterApi: {
    v2: {
      me: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockTwitterApi = {
      v2: {
        me: vi.fn(),
      },
    };

    vi.mocked(TwitterApi).mockImplementation(() => mockTwitterApi as unknown as TwitterApi);

    auth = new TwitterAuth({
      mode: "env",
      getAccessToken: async () => "test-access-token",
      getOAuth1Credentials: async () => ({
        appKey: "test-api-key",
        appSecret: "test-api-secret",
        accessToken: "test-access-token",
        accessSecret: "test-access-secret",
      }),
    });
  });

  describe("constructor", () => {
    it("should initialize with API credentials", () => {
      // Initialization happens lazily on first use.
      expect(TwitterApi).not.toHaveBeenCalled();
    });
  });

  describe("getV2Client", () => {
    it("should return the Twitter API v2 client", () => {
      return auth.getV2Client().then((client) => {
        expect(client).toBe(mockTwitterApi);
      });
    });
  });

  describe("isLoggedIn", () => {
    it("should return true when authenticated", async () => {
      mockTwitterApi.v2.me.mockResolvedValue({
        data: {
          id: "123456",
          username: "testuser",
        },
      });

      const isLoggedIn = await auth.isLoggedIn();
      expect(isLoggedIn).toBe(true);
      expect(mockTwitterApi.v2.me).toHaveBeenCalled();
    });

    it("should return false when API call fails", async () => {
      mockTwitterApi.v2.me.mockRejectedValue(new Error("Unauthorized"));

      const isLoggedIn = await auth.isLoggedIn();
      expect(isLoggedIn).toBe(false);
    });

    it("should return false when no user data returned", async () => {
      mockTwitterApi.v2.me.mockResolvedValue({});

      const isLoggedIn = await auth.isLoggedIn();
      expect(isLoggedIn).toBe(false);
    });
  });

  describe("me", () => {
    it("should return user profile", async () => {
      const mockUserData = {
        data: {
          id: "123456",
          username: "testuser",
          name: "Test User",
          description: "Test bio",
          profile_image_url: "https://example.com/avatar.jpg",
          public_metrics: {
            followers_count: 100,
            following_count: 50,
          },
          verified: true,
          location: "Test City",
          created_at: "2020-01-01T00:00:00.000Z",
        },
      };

      mockTwitterApi.v2.me.mockResolvedValue(mockUserData);

      const profile = await auth.me();

      expect(mockTwitterApi.v2.me).toHaveBeenCalledWith({
        "user.fields": [
          "id",
          "name",
          "username",
          "description",
          "profile_image_url",
          "public_metrics",
          "verified",
          "location",
          "created_at",
        ],
      });

      expect(profile).toEqual({
        userId: "123456",
        username: "testuser",
        name: "Test User",
        biography: "Test bio",
        avatar: "https://example.com/avatar.jpg",
        followersCount: 100,
        followingCount: 50,
        isVerified: true,
        location: "Test City",
        joined: new Date("2020-01-01T00:00:00.000Z"),
      });
    });

    it("should cache profile after first fetch", async () => {
      const mockUserData = {
        data: {
          id: "123456",
          username: "testuser",
          name: "Test User",
        },
      };

      mockTwitterApi.v2.me.mockResolvedValue(mockUserData);

      // First call
      const profile1 = await auth.me();
      // Second call
      const profile2 = await auth.me();

      // Should only call API once
      expect(mockTwitterApi.v2.me).toHaveBeenCalledTimes(1);
      expect(profile1).toBe(profile2);
    });

    it("should handle missing optional fields", async () => {
      const mockUserData = {
        data: {
          id: "123456",
          username: "testuser",
          name: "Test User",
          // No optional fields
        },
      };

      mockTwitterApi.v2.me.mockResolvedValue(mockUserData);

      const profile = await auth.me();

      expect(profile).toEqual({
        userId: "123456",
        username: "testuser",
        name: "Test User",
        biography: undefined,
        avatar: undefined,
        followersCount: undefined,
        followingCount: undefined,
        isVerified: undefined,
        location: "",
        joined: undefined,
      });
    });

    it("should return undefined on error", async () => {
      mockTwitterApi.v2.me.mockRejectedValue(new Error("API Error"));

      const profile = await auth.me();

      expect(profile).toBeUndefined();
    });
  });

  describe("logout", () => {
    it("should clear credentials and profile", async () => {
      // First login and fetch profile
      mockTwitterApi.v2.me.mockResolvedValue({
        data: { id: "123456", username: "testuser" },
      });

      await auth.me();

      // Then logout
      await auth.logout();

      // Try to get client after logout
      await expect(auth.getV2Client()).rejects.toThrow("Twitter API client not initialized");

      // isLoggedIn should return false
      const isLoggedIn = await auth.isLoggedIn();
      expect(isLoggedIn).toBe(false);
    });
  });

  describe("hasToken", () => {
    it("should return true when authenticated", () => {
      expect(auth.hasToken()).toBe(true);
    });

    it("should return false after logout", async () => {
      await auth.logout();
      expect(auth.hasToken()).toBe(false);
    });
  });
});
