export interface ChatMessage {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    confidence?: number
    suggestions?: string[]
}

// Kept for test helpers (not used by demo UI)
export interface WalletAddresses {
    solana: string
    evm: string
}
