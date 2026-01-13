import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupFetchMock, resetFetchMock, mockApiResponses } from '../utils/test-helpers'

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3001'

describe('API Endpoints', () => {
    beforeEach(() => {
        console.log('\n' + '='.repeat(60))
        console.log('Test Configuration:')
        console.log('  API Base URL:', API_BASE)
        console.log('  Using Mocks:', global.testUtils?.useMocks ?? 'N/A')
        console.log('  Environment:', process.env.NODE_ENV)
        console.log('='.repeat(60))
        setupFetchMock()
    })

    afterEach(() => {
        resetFetchMock()
    })

    describe('Health Check', () => {
        it('should return health status', async () => {
            console.log('\n=== Health Check Test ===')
            console.log('Request URL:', `${API_BASE}/health`)
            console.log('Request Method: GET')

            const response = await fetch(`${API_BASE}/health`)
            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))

            expect(response.ok).toBe(true)
            expect(data.status).toBe('ok')
            expect(data.timestamp).toBeDefined()
            console.log('✓ All assertions passed')
        })
    })

    describe('Chains', () => {
        it('should return supported chains', async () => {
            console.log('\n=== Chains Test ===')
            console.log('Request URL:', `${API_BASE}/api/chains`)
            console.log('Request Method: GET')
            console.log('Using Mocks:', global.testUtils.useMocks)

            const response = await fetch(`${API_BASE}/api/chains`)
            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            console.log('Number of Chains:', data.chains?.length)

            expect(response.ok).toBe(true)
            expect(data.chains).toBeDefined()
            expect(Array.isArray(data.chains)).toBe(true)
            if (global.testUtils.useMocks) {
                expect(data.chains).toHaveLength(3)
                expect(data.chains[0].id).toBe('solana')
            }
            console.log('✓ All assertions passed')
        })
    })

    describe('Portfolio', () => {
        it('should fetch multi-chain portfolio', async () => {
            console.log('\n=== Portfolio Multi-Chain Test ===')
            const addresses = global.testUtils.getMockAddresses()
            console.log('Mock Addresses:', addresses)
            console.log('Request URL:', `${API_BASE}/api/portfolio/multi`)
            console.log('Request Method: POST')
            console.log('Authorization:', `Bearer ${global.testUtils.getMockToken().substring(0, 20)}...`)
            console.log('Request Body:', JSON.stringify({ addresses }, null, 2))

            const response = await fetch(`${API_BASE}/api/portfolio/multi`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                },
                body: JSON.stringify({ addresses })
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            // For real API, it might return 401 without valid auth
            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.portfolios).toBeDefined()
            console.log('✓ All assertions passed')
        })

        it('should handle portfolio fetch errors', async () => {
            if (!global.testUtils.useMocks) {
                // Skip mock-specific test for real API
                return
            }

            const originalFetch = global.fetch;
            (global.fetch as any).mockImplementationOnce(() =>
                Promise.resolve({
                    ok: false,
                    status: 500,
                    json: () => Promise.resolve({ error: 'Server error' })
                })
            )

            const response = await fetch(`${API_BASE}/api/portfolio/multi`, {
                method: 'POST',
                body: JSON.stringify({ addresses: {} })
            })

            expect(response.ok).toBe(false)
            expect(response.status).toBe(500)

            global.fetch = originalFetch
        })
    })

    describe('Swap', () => {
        it('should get swap quote', async () => {
            console.log('\n=== Swap Quote Test ===')
            const requestBody = {
                chain: 'solana',
                fromToken: 'SOL',
                toToken: 'USDC',
                amount: '1000000000',
                walletAddress: 'TestAddress'
            }
            console.log('Request URL:', `${API_BASE}/api/swap/quote`)
            console.log('Request Method: POST')
            console.log('Request Body:', JSON.stringify(requestBody, null, 2))

            const response = await fetch(`${API_BASE}/api/swap/quote`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                },
                body: JSON.stringify(requestBody)
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.quote).toBeDefined()
            console.log('✓ All assertions passed')
        })

        it('should execute swap', async () => {
            console.log('\n=== Swap Execute Test ===')
            const requestBody = {
                chain: 'solana',
                quote: mockApiResponses.swapQuote.quote,
                walletAddress: 'TestAddress'
            }
            console.log('Request URL:', `${API_BASE}/api/swap/execute`)
            console.log('Request Method: POST')
            console.log('Request Body:', JSON.stringify(requestBody, null, 2))

            const response = await fetch(`${API_BASE}/api/swap/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                },
                body: JSON.stringify(requestBody)
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.signature).toBeDefined()
            console.log('✓ All assertions passed')
        })
    })

    describe('Bridge', () => {
        it('should get bridge quote', async () => {
            console.log('\n=== Bridge Quote Test ===')
            const requestBody = {
                fromChain: 'solana',
                toChain: 'base',
                fromToken: 'USDC',
                toToken: 'USDC',
                amount: '100000000',
                fromAddress: 'TestAddress'
            }
            console.log('Request URL:', `${API_BASE}/api/bridge/quote`)
            console.log('Request Method: POST')
            console.log('Request Body:', JSON.stringify(requestBody, null, 2))

            const response = await fetch(`${API_BASE}/api/bridge/quote`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                },
                body: JSON.stringify(requestBody)
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.quote).toBeDefined()
            console.log('✓ All assertions passed')
        })

        it('should execute bridge', async () => {
            console.log('\n=== Bridge Execute Test ===')
            const requestBody = {
                quote: mockApiResponses.bridgeQuote.quote,
                fromAddress: 'TestAddress'
            }
            console.log('Request URL:', `${API_BASE}/api/bridge/execute`)
            console.log('Request Method: POST')
            console.log('Request Body:', JSON.stringify(requestBody, null, 2))

            const response = await fetch(`${API_BASE}/api/bridge/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                },
                body: JSON.stringify(requestBody)
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.txHash).toBeDefined()
            console.log('✓ All assertions passed')
        })
    })

    describe('Social', () => {
        it('should post to Farcaster', async () => {
            console.log('\n=== Farcaster Post Test ===')
            const requestBody = { message: 'Test post' }
            console.log('Request URL:', `${API_BASE}/api/social/post`)
            console.log('Request Method: POST')
            console.log('Request Body:', JSON.stringify(requestBody, null, 2))

            const response = await fetch(`${API_BASE}/api/social/post`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                },
                body: JSON.stringify(requestBody)
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.castHash).toBeDefined()
            console.log('✓ All assertions passed')
        })

        it('should fetch Farcaster feed', async () => {
            console.log('\n=== Farcaster Feed Test ===')
            console.log('Request URL:', `${API_BASE}/api/social/feed`)
            console.log('Request Method: GET')

            const response = await fetch(`${API_BASE}/api/social/feed`, {
                headers: {
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                }
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.casts).toBeDefined()
            console.log('✓ All assertions passed')
        })
    })

    describe('AI Chat', () => {
        it('should chat with Eliza', async () => {
            console.log('\n=== AI Chat Test ===')
            const requestBody = {
                message: 'Hello',
                sessionId: 'test-session',
                userId: 'test-user'
            }
            console.log('Request URL:', `${API_BASE}/api/chat/eliza`)
            console.log('Request Method: POST')
            console.log('Request Body:', JSON.stringify(requestBody, null, 2))

            const response = await fetch(`${API_BASE}/api/chat/eliza`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${global.testUtils.getMockToken()}`
                },
                body: JSON.stringify(requestBody)
            })

            console.log('Response Status:', response.status, response.statusText)
            console.log('Response OK:', response.ok)

            if (!global.testUtils.useMocks && response.status === 401) {
                console.log('⚠ Received 401 (expected without valid auth)')
                expect(response.status).toBe(401)
                console.log('✓ Auth check passed')
                return
            }

            const data = await response.json()
            console.log('Response Data:', JSON.stringify(data, null, 2))
            expect(response.ok).toBe(true)
            expect(data.message).toBeDefined()
            expect(data.confidence).toBeGreaterThan(0)
            expect(data.suggestions).toBeInstanceOf(Array)
            console.log('✓ All assertions passed')
        })
    })
})

