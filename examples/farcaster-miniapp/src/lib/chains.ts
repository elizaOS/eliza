import type { Chain } from '../types'

export const SUPPORTED_CHAINS: Chain[] = [
    {
        id: 'solana',
        name: 'Solana',
        type: 'solana',
        icon: '◎',
        nativeCurrency: { symbol: 'SOL', decimals: 9 }
    },
    {
        id: 'ethereum',
        name: 'Ethereum',
        type: 'evm',
        chainId: 1,
        icon: 'Ξ',
        nativeCurrency: { symbol: 'ETH', decimals: 18 }
    },
    {
        id: 'base',
        name: 'Base',
        type: 'evm',
        chainId: 8453,
        icon: '🔵',
        nativeCurrency: { symbol: 'ETH', decimals: 18 }
    },
    {
        id: 'arbitrum',
        name: 'Arbitrum',
        type: 'evm',
        chainId: 42161,
        icon: '🔷',
        nativeCurrency: { symbol: 'ETH', decimals: 18 }
    },
    {
        id: 'optimism',
        name: 'Optimism',
        type: 'evm',
        chainId: 10,
        icon: '🔴',
        nativeCurrency: { symbol: 'ETH', decimals: 18 }
    }
]

export const POPULAR_TOKENS: Record<string, { address: string; symbol: string; name: string; decimals: number }[]> = {
    solana: [
        { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana', decimals: 9 },
        { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether', decimals: 6 },
        { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5 },
        { address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6 },
    ],
    ethereum: [
        { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18 },
        { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', name: 'Tether', decimals: 6 },
        { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai', decimals: 18 },
    ],
    base: [
        { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18 },
        { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai', decimals: 18 },
    ],
    arbitrum: [
        { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18 },
        { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether', decimals: 6 },
        { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', name: 'Dai', decimals: 18 },
    ],
    optimism: [
        { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18 },
        { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', name: 'Tether', decimals: 6 },
        { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', name: 'Dai', decimals: 18 },
    ],
}

export function getChainById(chainId: string): Chain | undefined {
    return SUPPORTED_CHAINS.find(chain => chain.id === chainId)
}

export function getChainName(chainId: string): string {
    return getChainById(chainId)?.name || chainId
}

export function getChainIcon(chainId: string): string {
    return getChainById(chainId)?.icon || '⛓️'
}

export function getTokensForChain(chainId: string) {
    return POPULAR_TOKENS[chainId] || []
}

