import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Create a mock class that matches the SmartThingsApi interface
class MockSmartThingsApi {
    private baseUrl = 'https://api.smartthings.com/v1';
    private token: string;

    constructor(runtime: IAgentRuntime) {
        this.token = runtime.getSetting("SMARTTHINGS_TOKEN");
        if (!this.token) {
            throw new Error("SmartThings token is required");
        }
    }

    private async request(endpoint: string, options: RequestInit = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });

        if (!response.ok) {
            throw new Error(`SmartThings API error: ${response.statusText}`);
        }

        return response.json();
    }

    devices = {
        list: () => this.request('/devices'),
        get: (deviceId: string) => this.request(`/devices/${deviceId}`),
        getStatus: (deviceId: string) => this.request(`/devices/${deviceId}/status`),
        executeCommand: (deviceId: string, command: any) =>
            this.request(`/devices/${deviceId}/commands`, {
                method: 'POST',
                body: JSON.stringify({
                    commands: [command]
                })
            }),
        executeCommands: (deviceId: string, commands: any[]) =>
            this.request(`/devices/${deviceId}/commands`, {
                method: 'POST',
                body: JSON.stringify({ commands })
            }),
        getComponents: (deviceId: string) =>
            this.request(`/devices/${deviceId}/components`),
        getCapabilities: (deviceId: string) =>
            this.request(`/devices/${deviceId}/capabilities`)
    };

    scenes = {
        list: () => this.request('/scenes'),
        execute: (sceneId: string) =>
            this.request(`/scenes/${sceneId}/execute`, {
                method: 'POST'
            })
    };

    rooms = {
        list: () => this.request('/rooms'),
        get: (roomId: string) => this.request(`/rooms/${roomId}`)
    };
}

describe('SmartThingsApi', () => {
    let api: MockSmartThingsApi;
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        mockRuntime = {
            getSetting: vi.fn().mockReturnValue('mock-token'),
        } as unknown as IAgentRuntime;
        api = new MockSmartThingsApi(mockRuntime);
    });

    it('should throw error if token is not provided', () => {
        const runtimeWithoutToken = {
            getSetting: vi.fn().mockReturnValue(null),
        } as unknown as IAgentRuntime;

        expect(() => new MockSmartThingsApi(runtimeWithoutToken))
            .toThrow('SmartThings token is required');
    });

    describe('devices', () => {
        beforeEach(() => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: 'success' }),
            });
        });

        it('should list devices', async () => {
            await api.devices.list();

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.smartthings.com/v1/devices',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer mock-token',
                        'Content-Type': 'application/json',
                    }),
                })
            );
        });

        it('should get device details', async () => {
            const deviceId = 'device123';
            await api.devices.get(deviceId);

            expect(mockFetch).toHaveBeenCalledWith(
                `https://api.smartthings.com/v1/devices/${deviceId}`,
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer mock-token',
                    }),
                })
            );
        });

        it('should execute device command', async () => {
            const deviceId = 'device123';
            const command = { capability: 'switch', command: 'on' };

            await api.devices.executeCommand(deviceId, command);

            expect(mockFetch).toHaveBeenCalledWith(
                `https://api.smartthings.com/v1/devices/${deviceId}/commands`,
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ commands: [command] }),
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer mock-token',
                        'Content-Type': 'application/json',
                    }),
                })
            );
        });

        it('should handle API errors', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                statusText: 'Not Found',
            });

            await expect(api.devices.list())
                .rejects
                .toThrow('SmartThings API error: Not Found');
        });
    });

    describe('scenes', () => {
        beforeEach(() => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: 'success' }),
            });
        });

        it('should list scenes', async () => {
            await api.scenes.list();

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.smartthings.com/v1/scenes',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer mock-token',
                    }),
                })
            );
        });

        it('should execute scene', async () => {
            const sceneId = 'scene123';
            await api.scenes.execute(sceneId);

            expect(mockFetch).toHaveBeenCalledWith(
                `https://api.smartthings.com/v1/scenes/${sceneId}/execute`,
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer mock-token',
                    }),
                })
            );
        });
    });

    describe('rooms', () => {
        beforeEach(() => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: 'success' }),
            });
        });

        it('should list rooms', async () => {
            await api.rooms.list();

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.smartthings.com/v1/rooms',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer mock-token',
                    }),
                })
            );
        });

        it('should get room details', async () => {
            const roomId = 'room123';
            await api.rooms.get(roomId);

            expect(mockFetch).toHaveBeenCalledWith(
                `https://api.smartthings.com/v1/rooms/${roomId}`,
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer mock-token',
                    }),
                })
            );
        });
    });
});
