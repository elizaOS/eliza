import { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramBridge } from "./bridge";
import type { TurnCoordinator } from "./turn-coordinator";

let mockSendMessage: ReturnType<typeof vi.fn>;

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function BotMock() {
    return {
      api: { sendMessage: mockSendMessage },
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      command: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

const MockedBot = vi.mocked(Bot);

function mockCoordinator(): TurnCoordinator {
  return { run: vi.fn((fn) => fn()) } as unknown as TurnCoordinator;
}

describe("createTelegramBridge", () => {
  describe("sendDm", () => {
    beforeEach(() => {
      mockSendMessage = vi.fn().mockResolvedValue(undefined);
      MockedBot.mockImplementation(function BotMock() {
        return {
          api: { sendMessage: mockSendMessage },
          start: vi.fn(),
          stop: vi.fn(),
          catch: vi.fn(),
          command: vi.fn(),
          on: vi.fn(),
        } as never;
      } as never);
    });

    it("sends short messages without splitting", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "Hello, world!");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "Hello, world!");
    });

    it("splits long messages and sends each part", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const longMessage = "a".repeat(5000);
      await bridge.sendDm(123, longMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenNthCalledWith(1, 123, "a".repeat(4096));
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 123, "a".repeat(904));
    });

    it("handles empty messages", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "");

      expect(mockSendMessage).toHaveBeenCalledTimes(0);
    });

    it("sends multiple parts for message exactly at limit", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const exactLimitMessage = "a".repeat(4096);
      await bridge.sendDm(123, exactLimitMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "a".repeat(4096));
    });
  });
});
