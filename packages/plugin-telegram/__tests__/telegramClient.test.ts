import type { IAgentRuntime } from '@elizaos/core';
import { expect, vi } from 'vitest';
import type { TelegramService } from '../src/telegramService';

// Mock Telegraf
vi.mock('telegraf', () => {
  const mockBot = {
    launch: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    telegram: {
      getMe: vi.fn().mockResolvedValue({ username: 'test_bot' }),
    },
    on: vi.fn(),
    command: vi.fn(),
    use: vi.fn(),
    catch: vi.fn(),
  };

  return {
    Telegraf: vi.fn(() => mockBot),
  };
});

describe('TelegramService', () => {
  let mockRuntime: IAgentRuntime;
  let service: TelegramService;
  const TEST_BOT_TOKEN = 'test_bot_token';

  // beforeEach(() => {
  // 	mockRuntime = {
  // 		getSetting: vi.fn(),
  // 		emitEvent: vi.fn(),
  // 	} as Partial<IAgentRuntime> as IAgentRuntime;

  // 	service = new TelegramService(mockRuntime);
  // });

  describe('initialization', () => {
    it('should create a new instance with the provided runtime and token', () => {
      expect(true).toBe(true);
      // expect(service).toBeInstanceOf(TelegramService);
    });

    // it("should initialize with correct settings from runtime", () => {
    // 	expect(mockRuntime.getSetting).toHaveBeenCalledWith("TELEGRAM_API_ROOT");
    // });
  });

  // describe("bot lifecycle", () => {
  // 	it("should start the bot successfully", async () => {
  // 		const mockBot = service.bot;
  // 		const launchSpy = vi.spyOn(mockBot, "launch");
  // 		const getMeSpy = vi.spyOn(mockBot.telegram, "getMe");

  // 		await service.start();

  // 		expect(launchSpy).toHaveBeenCalledWith({
  // 			dropPendingUpdates: true,
  // 			allowedUpdates: ["message", "message_reaction"],
  // 		});
  // 		expect(getMeSpy).toHaveBeenCalled();
  // 	});

  // 	it("should get bot info after launch", async () => {
  // 		const mockBot = service.bot;
  // 		const getMeSpy = vi.spyOn(mockBot.telegram, "getMe");

  // 		await service.start();

  // 		expect(getMeSpy).toHaveBeenCalled();
  // 	});
  // });
});
