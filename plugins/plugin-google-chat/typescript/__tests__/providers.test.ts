import { describe, expect, it, vi } from "vitest";
import { spaceStateProvider, userContextProvider } from "../src/providers/index.js";

describe("GoogleChatProviders", () => {
  describe("spaceStateProvider", () => {
    describe("metadata", () => {
      it("should have correct provider name", () => {
        expect(spaceStateProvider.name).toBe("googleChatSpaceState");
      });

      it("should have a non-empty description", () => {
        expect(spaceStateProvider.description).toBeTruthy();
        expect(spaceStateProvider.description.length).toBeGreaterThan(0);
      });
    });

    describe("get", () => {
      it("should return empty result for non-google-chat source", async () => {
        const mockMessage = {
          content: { source: "telegram" },
        };
        const mockState = {};

        const result = await spaceStateProvider.get(
          {} as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toBe("");
        expect(result.data).toEqual({});
        expect(result.values).toEqual({});
      });

      it("should return disconnected state when service is not found", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(null),
        };
        const mockState = {};

        const result = await spaceStateProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.data).toEqual({ connected: false });
        expect(result.values).toEqual({ connected: false });
      });

      it("should return disconnected state when service is not connected", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(false),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {};

        const result = await spaceStateProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.data).toEqual({ connected: false });
      });

      it("should return DM state text for DM space type", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          agentName: "TestBot",
          data: {
            space: {
              name: "spaces/DM_123",
              displayName: undefined,
              type: "DM",
              threaded: false,
            },
          },
        };

        const result = await spaceStateProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toContain("TestBot");
        expect(result.text).toContain("direct message");
        expect(result.text).toContain("Google Chat");
        expect(result.data).toMatchObject({
          isDirect: true,
          connected: true,
        });
      });

      it("should return space state text for regular space", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          agentName: "AgentX",
          data: {
            space: {
              name: "spaces/SPACE_456",
              displayName: "Engineering",
              type: "SPACE",
              threaded: false,
            },
          },
        };

        const result = await spaceStateProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toContain("AgentX");
        expect(result.text).toContain("Engineering");
        expect(result.data).toMatchObject({
          spaceDisplayName: "Engineering",
          isDirect: false,
          connected: true,
        });
      });

      it("should include threaded info for threaded spaces", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          data: {
            space: {
              name: "spaces/THREAD_789",
              displayName: "Threaded Room",
              type: "SPACE",
              threaded: true,
            },
          },
        };

        const result = await spaceStateProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toContain("threaded");
        expect(result.data).toMatchObject({
          isThreaded: true,
        });
      });

      it("should detect DM via singleUserBotDm flag", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          data: {
            space: {
              name: "spaces/BOT_DM_1",
              type: "SPACE",
              singleUserBotDm: true,
            },
          },
        };

        const result = await spaceStateProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.data).toMatchObject({
          isDirect: true,
        });
      });
    });
  });

  describe("userContextProvider", () => {
    describe("metadata", () => {
      it("should have correct provider name", () => {
        expect(userContextProvider.name).toBe("googleChatUserContext");
      });

      it("should have a non-empty description", () => {
        expect(userContextProvider.description).toBeTruthy();
        expect(userContextProvider.description.length).toBeGreaterThan(0);
      });
    });

    describe("get", () => {
      it("should return empty result for non-google-chat source", async () => {
        const mockMessage = {
          content: { source: "discord" },
        };
        const mockState = {};

        const result = await userContextProvider.get(
          {} as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toBe("");
        expect(result.data).toEqual({});
      });

      it("should return disconnected state when service is not found", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(null),
        };
        const mockState = {};

        const result = await userContextProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.data).toEqual({ connected: false });
      });

      it("should return empty text when no sender in state", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          data: {},
        };

        const result = await userContextProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toBe("");
        expect(result.data).toEqual({ connected: true });
      });

      it("should return user context when sender is available", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          agentName: "TestBot",
          data: {
            sender: {
              name: "users/USER123",
              displayName: "Jane Doe",
              email: "jane@example.com",
              type: "HUMAN",
            },
          },
        };

        const result = await userContextProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toContain("TestBot");
        expect(result.text).toContain("Jane Doe");
        expect(result.text).toContain("jane@example.com");
        expect(result.text).toContain("Google Chat");
        expect(result.data).toMatchObject({
          userName: "users/USER123",
          userId: "USER123",
          displayName: "Jane Doe",
          email: "jane@example.com",
          userType: "HUMAN",
          isBot: false,
        });
      });

      it("should identify bot users", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          agentName: "TestBot",
          data: {
            sender: {
              name: "users/BOT456",
              displayName: "Another Bot",
              type: "BOT",
            },
          },
        };

        const result = await userContextProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.text).toContain("bot");
        expect(result.data).toMatchObject({
          isBot: true,
          userType: "BOT",
        });
      });

      it("should use resource ID when display name is not set", async () => {
        const mockMessage = {
          content: { source: "google-chat" },
        };
        const mockService = {
          isConnected: vi.fn().mockReturnValue(true),
        };
        const mockRuntime = {
          getService: vi.fn().mockReturnValue(mockService),
        };
        const mockState = {
          data: {
            sender: {
              name: "users/NOIDUSER",
            },
          },
        };

        const result = await userContextProvider.get(
          mockRuntime as never,
          mockMessage as never,
          mockState as never,
        );

        expect(result.data).toMatchObject({
          displayName: "NOIDUSER",
          userId: "NOIDUSER",
        });
      });
    });
  });
});
