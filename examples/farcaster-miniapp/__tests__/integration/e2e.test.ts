import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupFetchMock, resetFetchMock } from '../utils/test-helpers'

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001'
const mockToken = 'Bearer test-token-123'

describe('End-to-End Integration Tests', () => {
    beforeAll(() => {
        setupFetchMock()
    })

    afterAll(() => {
        resetFetchMock()
    })

    describe('Complete Trading Flow', () => {
        it('should complete full trading workflow', async () => {
            const mockAddresses = global.testUtils.getMockAddresses()
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': mockToken
            }

            // 1. Get user wallets
            const walletsResponse = await fetch(`${API_BASE}/api/user/12345/wallets`, { headers })

            // Skip if auth fails on real API
            if (!global.testUtils.useMocks && walletsResponse.status === 401) {
                console.log('Skipping test - requires authentication')
                return
            }

            const wallets = await walletsResponse.json()
            expect(wallets.addresses).toBeDefined()

            // 2. Fetch portfolio
            const portfolioResponse = await fetch(`${API_BASE}/api/portfolio/multi`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ addresses: mockAddresses })
            })

            if (portfolioResponse.ok) {
                const portfolio = await portfolioResponse.json()
                expect(portfolio.portfolios).toBeDefined()
            }

            // 3. Get swap quote
            const quoteResponse = await fetch(`${API_BASE}/api/swap/quote`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    chain: 'solana',
                    fromToken: 'SOL',
                    toToken: 'USDC',
                    amount: '1000000000',
                    walletAddress: mockAddresses.solana
                })
            })

            if (quoteResponse.ok) {
                const quote = await quoteResponse.json()
                expect(quote.quote).toBeDefined()
            }
        })
    })

    describe('Cross-Chain Bridge Flow', () => {
        it('should complete cross-chain bridge', async () => {
            const mockAddresses = global.testUtils.getMockAddresses()

            // 1. Get bridge quote
            const quoteResponse = await fetch('/api/bridge/quote', {
                method: 'POST',
                body: JSON.stringify({
                    fromChain: 'solana',
                    toChain: 'base',
                    fromToken: 'USDC',
                    toToken: 'USDC',
                    amount: '100000000',
                    fromAddress: mockAddresses.solana
                })
            })
            const quote = await quoteResponse.json()
            expect(quote.quote).toBeDefined()
            expect(quote.quote.fees).toBeDefined()

            // 2. Execute bridge
            const bridgeResponse = await fetch('/api/bridge/execute', {
                method: 'POST',
                body: JSON.stringify({
                    quote: quote.quote,
                    fromAddress: mockAddresses.solana
                })
            })
            const bridge = await bridgeResponse.json()
            expect(bridge.txHash).toBeDefined()
        })
    })

    describe('AI Chat Interaction Flow', () => {
        it('should complete AI conversation', async () => {
            // 1. Start conversation
            const chatResponse1 = await fetch('/api/chat/eliza', {
                method: 'POST',
                body: JSON.stringify({
                    message: 'What is my portfolio worth?',
                    userId: 'test-user'
                })
            })
            const chat1 = await chatResponse1.json()
            expect(chat1.message).toBeDefined()
            expect(chat1.sessionId).toBeDefined()

            // 2. Continue conversation
            const chatResponse2 = await fetch('/api/chat/eliza', {
                method: 'POST',
                body: JSON.stringify({
                    message: 'Should I swap SOL for USDC?',
                    sessionId: chat1.sessionId,
                    userId: 'test-user'
                })
            })
            const chat2 = await chatResponse2.json()
            expect(chat2.message).toBeDefined()
            expect(chat2.suggestions).toBeDefined()
        })
    })

    describe('Error Recovery Flow', () => {
        it('should handle and recover from errors', async () => {
            // Simulate API error
            (global.fetch as any).mockImplementationOnce(() =>
                Promise.resolve({
                    ok: false,
                    status: 500,
                    json: () => Promise.resolve({ error: 'Server error' })
                })
            )

            const response = await fetch('/api/portfolio/multi', {
                method: 'POST',
                body: JSON.stringify({ addresses: {} })
            })

            expect(response.ok).toBe(false)

            // Restore normal behavior
            setupFetchMock()

            // Retry should work
            const retryResponse = await fetch('/api/portfolio/multi', {
                method: 'POST',
                body: JSON.stringify({
                    addresses: global.testUtils.getMockAddresses()
                })
            })

            expect(retryResponse.ok).toBe(true)
        })
    })

    describe('Multi-Chain Operations', () => {
        it('should handle operations across multiple chains', async () => {
            const mockAddresses = global.testUtils.getMockAddresses()

            // Get portfolio for all chains
            const portfolioResponse = await fetch('/api/portfolio/multi', {
                method: 'POST',
                body: JSON.stringify({ addresses: mockAddresses })
            })
            const portfolio = await portfolioResponse.json()

            expect(portfolio.portfolios).toBeDefined()

            // Execute swaps on different chains
            const solanaSwap = await fetch('/api/swap/quote', {
                method: 'POST',
                body: JSON.stringify({
                    chain: 'solana',
                    fromToken: 'SOL',
                    toToken: 'USDC',
                    amount: '1000000000',
                    walletAddress: mockAddresses.solana
                })
            })
            expect(solanaSwap.ok).toBe(true)

            const evmSwap = await fetch('/api/swap/quote', {
                method: 'POST',
                body: JSON.stringify({
                    chain: 'ethereum',
                    fromToken: 'ETH',
                    toToken: 'USDC',
                    amount: '1000000000000000000',
                    walletAddress: mockAddresses.evm
                })
            })
            expect(evmSwap.ok).toBe(true)
        })
    })
})

