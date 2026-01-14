import { render, RenderOptions } from '@testing-library/react'
import { ReactElement } from 'react'
import { vi } from 'vitest'
import type { WalletAddresses } from '../../src/types'

// Mock API responses
export const mockApiResponses = {
    chains: {
        chains: [
            { id: 'solana', name: 'Solana', type: 'solana', icon: '◎' },
            { id: 'ethereum', name: 'Ethereum', type: 'evm', chainId: 1, icon: 'Ξ' },
            { id: 'base', name: 'Base', type: 'evm', chainId: 8453, icon: '🔵' },
        ]
    },

    portfolio: {
        portfolios: [
            {
                chain: 'solana',
                address: 'TestAddress',
                nativeBalance: '1000000000',
                nativeBalanceUSD: '100',
                tokens: [
                    { symbol: 'USDC', name: 'USD Coin', balance: '1000000', decimals: 6 }
                ],
                totalValueUSD: '150'
            }
        ]
    },

    swapQuote: {
        quote: {
            inputToken: 'SOL',
            outputToken: 'USDC',
            inputAmount: '1000000000',
            outputAmount: '100000000',
            priceImpact: '0.5',
            estimatedGas: '5000'
        }
    },

    bridgeQuote: {
        quote: {
            fromChain: 'solana',
            toChain: 'base',
            fromToken: 'USDC',
            toToken: 'USDC',
            fromAmount: '100000000',
            toAmount: '99500000',
            estimatedTime: '5-10 minutes',
            fees: [{ amount: '0.5', token: 'USDC' }]
        }
    },

    farcasterFeed: {
        casts: [
            {
                hash: 'test-hash',
                author: {
                    fid: 12345,
                    username: 'testuser',
                    displayName: 'Test User',
                    pfpUrl: 'https://example.com/avatar.png'
                },
                text: 'Test cast',
                timestamp: new Date().toISOString(),
                reactions: { likes: 10, recasts: 5, replies: 2 }
            }
        ]
    },

    elizaChat: {
        message: 'Hello! How can I help you today?',
        confidence: 0.95,
        suggestions: ['Check portfolio', 'Execute swap', 'Bridge tokens'],
        sessionId: 'test-session-123'
    }
}

// Setup fetch mock (only if using mocks)
export function setupFetchMock() {
    if (!global.testUtils.useMocks) {
        // Use real fetch when not mocking
        return
    }

    (global.fetch as any).mockImplementation((url: string, options?: any) => {
        const urlStr = url.toString()

        // Health check
        if (urlStr.includes('/health')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ status: 'ok', timestamp: new Date().toISOString() })
            })
        }

        // Chains
        if (urlStr.includes('/api/chains')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(mockApiResponses.chains)
            })
        }

        // Portfolio
        if (urlStr.includes('/api/portfolio/multi')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(mockApiResponses.portfolio)
            })
        }

        // Swap quote
        if (urlStr.includes('/api/swap/quote')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(mockApiResponses.swapQuote)
            })
        }

        // Swap execute
        if (urlStr.includes('/api/swap/execute')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ signature: 'test-signature-123' })
            })
        }

        // Bridge quote
        if (urlStr.includes('/api/bridge/quote')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(mockApiResponses.bridgeQuote)
            })
        }

        // Bridge execute
        if (urlStr.includes('/api/bridge/execute')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ txHash: '0xtest-hash-123' })
            })
        }

        // Social post
        if (urlStr.includes('/api/social/post')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ castHash: 'test-cast-hash' })
            })
        }

        // Social feed
        if (urlStr.includes('/api/social/feed')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(mockApiResponses.farcasterFeed)
            })
        }

        // Eliza chat
        if (urlStr.includes('/api/chat/eliza')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(mockApiResponses.elizaChat)
            })
        }

        // User wallets
        if (urlStr.includes('/api/user/')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    addresses: global.testUtils.getMockAddresses()
                })
            })
        }

        // Default 404
        return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: 'Not found' })
        })
    })
}

// Reset fetch mock
export function resetFetchMock() {
    if (global.testUtils.useMocks && global.fetch && typeof (global.fetch as any).mockClear === 'function') {
        (global.fetch as any).mockClear()
    }
}

// Custom render with providers
export function renderWithProviders(
    ui: ReactElement,
    options?: Omit<RenderOptions, 'wrapper'>
) {
    return render(ui, { ...options })
}

// Wait for element to appear
export async function waitForElement(callback: () => any, timeout = 3000) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
        try {
            const result = callback()
            if (result) return result
        } catch (e) {
            // Continue waiting
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    throw new Error('Timeout waiting for element')
}

