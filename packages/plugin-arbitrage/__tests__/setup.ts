import { vi } from 'vitest';
import { WebSocket } from 'ws';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';

// Mock WebSocket
vi.mock('ws', () => ({
    WebSocket: vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        close: vi.fn(),
        send: vi.fn()
    }))
}));

// Mock ethers providers
vi.mock('@ethersproject/providers', () => ({
    WebSocketProvider: vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        getGasPrice: vi.fn().mockResolvedValue('1000000000'),
        getBlock: vi.fn().mockResolvedValue({ number: 1 })
    }))
}));

// Mock Flashbots provider
vi.mock('@flashbots/ethers-provider-bundle', () => ({
    FlashbotsBundleProvider: {
        create: vi.fn().mockResolvedValue({
            sendBundle: vi.fn().mockResolvedValue({
                wait: vi.fn().mockResolvedValue(true)
            }),
            simulate: vi.fn().mockResolvedValue({
                success: true,
                profit: '1000000000000000'
            })
        })
    }
}));

// Mock @elizaos/core
vi.mock('@elizaos/core', () => ({
    Service: class {},
    ServiceType: {
        ARBITRAGE: 'arbitrage'
    },
    elizaLogger: {
        info: vi.fn(),
        error: vi.fn(),
        log: vi.fn()
    }
}));
