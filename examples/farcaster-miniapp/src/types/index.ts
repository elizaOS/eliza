export type ChainType = 'solana' | 'evm'

export interface Chain {
    id: string
    name: string
    type: ChainType
    chainId?: number
    icon: string
    nativeCurrency: {
        symbol: string
        decimals: number
    }
}

export interface WalletAddresses {
    solana: string
    evm: string
}

export interface Token {
    address: string
    symbol: string
    name: string
    decimals: number
    logoURI?: string
    balance?: string
    balanceUSD?: string
}

export interface Portfolio {
    chain: string
    address: string
    nativeBalance: string
    nativeBalanceUSD?: string
    tokens: Token[]
    totalValueUSD?: string
}

export interface SwapQuote {
    inputToken: string
    outputToken: string
    inputAmount: string
    outputAmount: string
    priceImpact?: string
    estimatedGas?: string
    route?: any
}

export interface BridgeQuote {
    fromChain: string
    toChain: string
    fromToken: string
    toToken: string
    fromAmount: string
    toAmount: string
    estimatedTime?: string
    fees?: {
        amount: string
        token: string
    }[]
    route?: any
}

export interface FarcasterCast {
    hash: string
    author: {
        fid: number
        username: string
        displayName: string
        pfpUrl?: string
    }
    text: string
    timestamp: string
    reactions?: {
        likes: number
        recasts: number
        replies: number
    }
}

export interface ChatMessage {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    confidence?: number
    suggestions?: string[]
}

export interface User {
    fid: number
    username?: string
    displayName?: string
    pfpUrl?: string
}

