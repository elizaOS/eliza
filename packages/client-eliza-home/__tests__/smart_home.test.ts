import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmartHomeManager } from '../src/smart_home';
import { SmartThingsApi } from '../src/services/smart_things_api';
import { CommandParser } from '../src/utils/command_parser';
import type { IAgentRuntime } from '@elizaos/core';

// Define mock interface that extends IAgentRuntime
interface MockAgentRuntime extends IAgentRuntime {
    llm: {
        shouldRespond: ReturnType<typeof vi.fn>;
        complete: ReturnType<typeof vi.fn>;
    };
}

// Mock dependencies
vi.mock('../src/services/smart_things_api', () => ({
    SmartThingsApi: vi.fn().mockImplementation(() => ({
        devices: {
            list: vi.fn().mockResolvedValue([]),
            executeCommand: vi.fn().mockResolvedValue({ status: 'success' })
        }
    }))
}));
vi.mock('../src/utils/command_parser');
vi.mock('@elizaos/core', () => ({
    elizaLogger: {
        error: vi.fn(),
    },
}));

describe('SmartHomeManager', () => {
    let smartHomeManager: SmartHomeManager;
    let mockRuntime: MockAgentRuntime;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Create mock runtime with proper typing
        mockRuntime = {
            llm: {
                shouldRespond: vi.fn(),
                complete: vi.fn(),
            },
            getSetting: vi.fn().mockReturnValue('mock-token'),
            // Add required IAgentRuntime properties
            agentId: 'test-agent-id',
            serverUrl: 'http://test-server',
            databaseAdapter: {
                init: vi.fn(),
                close: vi.fn(),
                // Add other required database methods as needed
            },
            token: 'test-token',
            modelProvider: 'test-provider',
        } as MockAgentRuntime;

        smartHomeManager = new SmartHomeManager(mockRuntime);
    });

    describe('handleCommand', () => {
        it('should return null when shouldRespond returns IGNORE', async () => {
            // Arrange
            vi.mocked(mockRuntime.llm.shouldRespond).mockResolvedValue('IGNORE');

            // Act
            const result = await smartHomeManager.handleCommand('turn on lights', 'user123');

            // Assert
            expect(result).toBeNull();
            expect(mockRuntime.llm.shouldRespond).toHaveBeenCalledWith(
                expect.any(String),
                'turn on lights'
            );
        });

        it('should execute command and return response when shouldRespond returns RESPOND', async () => {
            // Arrange
            const mockResponse = 'Command executed successfully';
            vi.mocked(mockRuntime.llm.shouldRespond).mockResolvedValue('RESPOND');
            vi.mocked(mockRuntime.llm.complete).mockResolvedValue(mockResponse);
            vi.mocked(CommandParser.parseCommand).mockReturnValue({
                command: 'turn_on',
                args: { device: 'lights' }
            });
            vi.mocked(CommandParser.mapToDeviceCommand).mockReturnValue({
                deviceId: 'device123',
                capability: 'switch',
                command: 'on'
            });

            // Act
            const result = await smartHomeManager.handleCommand('turn on lights', 'user123');

            // Assert
            expect(result).toEqual({
                success: true,
                message: mockResponse,
                data: { status: 'success' }
            });
            expect(mockRuntime.llm.shouldRespond).toHaveBeenCalled();
            expect(mockRuntime.llm.complete).toHaveBeenCalled();
            expect(CommandParser.parseCommand).toHaveBeenCalledWith('turn on lights');
            expect(CommandParser.mapToDeviceCommand).toHaveBeenCalled();
        });

        it('should handle errors gracefully', async () => {
            // Arrange
            const mockError = new Error('Test error');
            vi.mocked(mockRuntime.llm.shouldRespond).mockRejectedValue(mockError);

            // Act & Assert
            await expect(smartHomeManager.handleCommand('turn on lights', 'user123'))
                .rejects
                .toThrow(mockError);
        });
    });
});
