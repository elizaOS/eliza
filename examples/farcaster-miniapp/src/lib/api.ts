import { sdk } from '@farcaster/miniapp-sdk'
import type { WalletAddresses, Portfolio, SwapQuote, BridgeQuote, FarcasterCast } from '../types'

const API_BASE = '/api'

async function getAuthToken(): Promise<string> {
    const { token } = await sdk.quickAuth.getToken()
    return token
}

async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = await getAuthToken()

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            ...options.headers,
        },
    })

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(error.error || `HTTP ${response.status}`)
    }

    return response.json()
}

export const api = {
    // Get supported chains
    async getChains() {
        return apiRequest<{ chains: any[] }>('/chains')
    },

    // Get user wallet addresses
    async getUserWallets(fid: number): Promise<{ addresses: WalletAddresses }> {
        return apiRequest(`/user/${fid}/wallets`)
    },

    // Get multi-chain portfolio
    async getMultiChainPortfolio(addresses: WalletAddresses): Promise<{ portfolios: Portfolio[] }> {
        return apiRequest('/portfolio/multi', {
            method: 'POST',
            body: JSON.stringify({ addresses }),
        })
    },

    // Get swap quote
    async getSwapQuote(params: {
        chain: string
        fromToken: string
        toToken: string
        amount: string
        walletAddress: string
    }): Promise<{ quote: SwapQuote }> {
        return apiRequest('/swap/quote', {
            method: 'POST',
            body: JSON.stringify(params),
        })
    },

    // Execute swap
    async executeSwap(params: {
        chain: string
        quote: SwapQuote
        walletAddress: string
    }): Promise<{ signature?: string; txHash?: string }> {
        return apiRequest('/swap/execute', {
            method: 'POST',
            body: JSON.stringify(params),
        })
    },

    // Get bridge quote
    async getBridgeQuote(params: {
        fromChain: string
        toChain: string
        fromToken: string
        toToken: string
        amount: string
        fromAddress: string
    }): Promise<{ quote: BridgeQuote }> {
        return apiRequest('/bridge/quote', {
            method: 'POST',
            body: JSON.stringify(params),
        })
    },

    // Execute bridge
    async executeBridge(params: {
        quote: BridgeQuote
        fromAddress: string
    }): Promise<{ txHash: string }> {
        return apiRequest('/bridge/execute', {
            method: 'POST',
            body: JSON.stringify(params),
        })
    },

    // Post to Farcaster
    async postToFarcaster(message: string): Promise<{ castHash: string }> {
        return apiRequest('/social/post', {
            method: 'POST',
            body: JSON.stringify({ message }),
        })
    },

    // Get Farcaster feed
    async getFarcasterFeed(): Promise<{ casts: FarcasterCast[] }> {
        return apiRequest('/social/feed')
    },

    // Chat with Eliza AI
    async chatWithEliza(params: {
        message: string
        sessionId?: string
        userId?: string
    }): Promise<{
        message: string
        confidence: number
        suggestions: string[]
        sessionId: string
    }> {
        return apiRequest('/chat/eliza', {
            method: 'POST',
            body: JSON.stringify(params),
        })
    },
}

