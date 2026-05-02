import { beforeAll, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
type WalletAddresses = { solana: string; evm: string }

// Extend global namespace for test utilities
declare global {
    var testUtils: {
        getMockToken: () => string
        getMockAddresses: () => WalletAddresses
        wait: (ms: number) => Promise<void>
        useMocks: boolean
        fetchMock?: Mock<Parameters<typeof fetch>, ReturnType<typeof fetch>>
    }
}

// Check if we should use mocks (default: true, set USE_REAL_API=true to use real backend)
const useMocks = process.env.USE_REAL_API !== 'true'

// Setup global test environment
beforeAll(() => {
    // Mock environment variables
    process.env.NODE_ENV = 'test'
    process.env.ELIZA_API_URL = process.env.ELIZA_API_URL || 'http://localhost:3000'
    process.env.PORT = process.env.PORT || '3001'
})

// Cleanup after each test
afterEach(() => {
    cleanup()
    global.testUtils.fetchMock?.mockClear()
})

// Global test utilities
global.testUtils = {
    useMocks,

    // Mock JWT token
    getMockToken: () => {
        const payload = { sub: '12345', exp: Date.now() + 3600000 }
        return Buffer.from(JSON.stringify(payload)).toString('base64')
    },

    // Mock wallet addresses
    getMockAddresses: () => ({
        solana: 'TestSolanaAddress123456789',
        evm: '0x1234567890123456789012345678901234567890'
    }),

    // Wait for async operations
    wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
}

// Only mock if not using real API
if (useMocks) {
    // Mock Farcaster SDK
    vi.mock('@farcaster/miniapp-sdk', () => ({
        sdk: {
            actions: {
                ready: vi.fn(() => Promise.resolve())
            }
        }
    }))

    // Mock fetch globally
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
    globalThis.fetch = fetchMock
    global.testUtils.fetchMock = fetchMock
}

