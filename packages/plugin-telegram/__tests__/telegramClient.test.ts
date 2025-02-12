import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramClient } from '../src/telegramClient';
import type { IAgentRuntime } from '@elizaos/core';

// Mock Telegraf
vi.mock('telegraf', () => {
    const mockBot = {
        launch: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        telegram: {
            getMe: vi.fn().mockResolvedValue({ username: 'test_bot' })
        },
        on: vi.fn(),
        command: vi.fn(),
        use: vi.fn(),
        catch: vi.fn()
    };

    return {
        Telegraf: vi.fn(() => mockBot)
    };
});

describe('TelegramClient', () => {
    let mockRuntime: IAgentRuntime;
    let client: TelegramClient;
    const TEST_BOT_TOKEN = 'test_bot_token';

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                switch (key) {
                    case 'BACKEND_URL':
                        return 'http://localhost:3000';
                    case 'BACKEND_TOKEN':
                        return 'test_backend_token';
                    case 'TG_TRADER':
                        return 'false';
                    default:
                        return undefined;
                }
            }),
            getCharacter: vi.fn(),
            getFlow: vi.fn(),
            getPlugin: vi.fn(),
            getPlugins: vi.fn(),
            getSafePlugins: vi.fn(),
            hasPlugin: vi.fn(),
            registerPlugin: vi.fn(),
            removePlugin: vi.fn(),
            setCharacter: vi.fn(),
            setFlow: vi.fn()
        };

        client = new TelegramClient(mockRuntime, TEST_BOT_TOKEN);
    });

    describe('initialization', () => {
        it('should create a new instance with the provided runtime and token', () => {
            expect(client).toBeInstanceOf(TelegramClient);
        });

        it('should initialize with correct settings from runtime', () => {
            expect(mockRuntime.getSetting).toHaveBeenCalledWith('BACKEND_URL');
            expect(mockRuntime.getSetting).toHaveBeenCalledWith('BACKEND_TOKEN');
            expect(mockRuntime.getSetting).toHaveBeenCalledWith('TG_TRADER');
        });
    });

    describe('bot lifecycle', () => {
        it('should start the bot successfully', async () => {
            const mockBot = client['bot'];
            const launchSpy = vi.spyOn(mockBot, 'launch');
            const getMeSpy = vi.spyOn(mockBot.telegram, 'getMe');

            await client.start();

            expect(launchSpy).toHaveBeenCalledWith({ dropPendingUpdates: true });
            expect(getMeSpy).toHaveBeenCalled();
        });

        it('should get bot info after launch', async () => {
            const mockBot = client['bot'];
            const getMeSpy = vi.spyOn(mockBot.telegram, 'getMe');

            await client.start();

            expect(getMeSpy).toHaveBeenCalled();
        });
    });
});
