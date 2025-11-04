/**
 * Configuration for x402 micropayment system
 * Route-specific pricing is now defined locally in each route definition
 * 
 * Payment Verification Methods:
 * 
 * 1. Direct Blockchain Proof (X-Payment-Proof header)
 *    - User sends payment transaction on-chain
 *    - Transaction signature is verified against blockchain
 *    - Supports: Solana, Base, Polygon
 *    - Format: base64-encoded JSON with signature and authorization
 * 
 * 2. Facilitator Payment ID (X-Payment-Id header)
 *    - Third-party service handles payment
 *    - Service returns payment ID after successful payment
 *    - ID is verified through facilitator API
 *    - Configured via X402_FACILITATOR_URL environment variable
 *    - Example: X402_FACILITATOR_URL=https://facilitator.x402.ai
 * 
 * The facilitator endpoint should implement:
 *   GET /verify/{paymentId}
 *     - 200 OK: Payment is valid (with optional { valid: true } JSON body)
 *     - 404 Not Found: Payment ID doesn't exist
 *     - 410 Gone: Payment already used (prevents replay attacks)
 */

import type { X402ScanNetwork } from './x402-types.js';
import type { Network as CoreNetwork } from '@elizaos/core';

// Re-export Network type from core
export type Network = CoreNetwork;

/**
 * Built-in networks supported by default
 */
export const BUILT_IN_NETWORKS = ['BASE', 'SOLANA', 'POLYGON'] as const;

// Default network configuration
export const DEFAULT_NETWORK: Network = 'SOLANA';

/**
 * Convert our Network type to x402scan-compliant network names
 */
export function toX402Network(network: Network): X402ScanNetwork {
    const networkMap: Record<Network, X402ScanNetwork> = {
        'BASE': 'base',
        'SOLANA': 'solana',
        'POLYGON': 'polygon'
    };
    return networkMap[network];
}

/**
 * Network-specific wallet addresses
 * Uses existing environment variables from your project configuration
 */
export const PAYMENT_ADDRESSES: Record<Network, string> = {
    BASE: process.env.BASE_PUBLIC_KEY || process.env.PAYMENT_WALLET_BASE || '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
    SOLANA: process.env.SOLANA_PUBLIC_KEY || process.env.PAYMENT_WALLET_SOLANA || '3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J',
    POLYGON: process.env.POLYGON_PUBLIC_KEY || process.env.PAYMENT_WALLET_POLYGON || '',
};

/**
 * Get the base URL for the current server
 * Used to construct full resource URLs for x402 responses
 */
export function getBaseUrl(): string {
    // Check for explicit base URL setting
    if (process.env.X402_BASE_URL) {
        return process.env.X402_BASE_URL.replace(/\/$/, ''); // Remove trailing slash
    }

    return 'https://x402.elizaos.ai'
}

/**
 * Convert a route path to a full resource URL
 */
export function toResourceUrl(path: string): string {
    const baseUrl = getBaseUrl();
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${baseUrl}${cleanPath}`;
}

/**
 * Token configuration for Solana
 */
export const SOLANA_TOKENS = {
    USDC: {
        symbol: 'USDC',
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6
    },
    AI16Z: {
        symbol: 'ai16z',
        address: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
        decimals: 6
    },
    DEGENAI: {
        symbol: 'degenai',
        address: 'Gu3LDkn7Vx3bmCzLafYNKcDxv2mH7YN44NJZFXnypump',
        decimals: 6
    }
} as const;

/**
 * Token configuration for Base (EVM)
 */
export const BASE_TOKENS = {
    USDC: {
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6
    }
} as const;

/**
 * Token configuration for Polygon (EVM)
 */
export const POLYGON_TOKENS = {
    USDC: {
        symbol: 'USDC',
        address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        decimals: 6
    }
} as const;

/**
 * Default asset for each network (used in x402 responses)
 */
export const NETWORK_ASSETS: Record<Network, string> = {
    BASE: 'USDC',      // USDC on Base
    SOLANA: 'USDC',    // USDC on Solana (default, but also supports ai16z and degenai)
    POLYGON: 'USDC',   // USDC on Polygon
};

/**
 * Get all accepted assets for a network
 */
export function getNetworkAssets(network: Network): string[] {
    if (network === 'SOLANA') {
        return Object.values(SOLANA_TOKENS).map(t => t.symbol);
    }
    if (network === 'BASE') {
        return Object.values(BASE_TOKENS).map(t => t.symbol);
    }
    if (network === 'POLYGON') {
        return Object.values(POLYGON_TOKENS).map(t => t.symbol);
    }
    return [NETWORK_ASSETS[network]];
}

// Default/legacy wallet address (uses default network)
export const PAYMENT_RECEIVER_ADDRESS = PAYMENT_ADDRESSES[DEFAULT_NETWORK];

/**
 * Named payment config definition - stores individual fields, CAIP-19 constructed on-demand
 */
export interface PaymentConfigDefinition {
    network: Network;
    assetNamespace: string;      // e.g., "erc20", "spl-token", "slip44"
    assetReference: string;       // e.g., contract address or token mint
    paymentAddress: string;       // Recipient address
    symbol: string;               // Display symbol (USDC, ETH, etc.)
    chainId?: string;             // Optional chain ID for CAIP-2 (e.g., "8453" for Base)
}

/**
 * Payment configuration registry - named configs for easy reference
 */
export const PAYMENT_CONFIGS: Record<string, PaymentConfigDefinition> = {
    'base_usdc': {
        network: 'BASE',
        assetNamespace: 'erc20',
        assetReference: BASE_TOKENS.USDC.address,
        paymentAddress: PAYMENT_ADDRESSES['BASE'],
        symbol: 'USDC',
        chainId: '8453'
    },
    'solana_usdc': {
        network: 'SOLANA',
        assetNamespace: 'spl-token',
        assetReference: SOLANA_TOKENS.USDC.address,
        paymentAddress: PAYMENT_ADDRESSES['SOLANA'],
        symbol: 'USDC'
    },
    'polygon_usdc': {
        network: 'POLYGON',
        assetNamespace: 'erc20',
        assetReference: POLYGON_TOKENS.USDC.address,
        paymentAddress: PAYMENT_ADDRESSES['POLYGON'],
        symbol: 'USDC',
        chainId: '137'
    }
};

/**
 * Construct CAIP-19 asset ID from payment config fields
 */
export function getCAIP19FromConfig(config: PaymentConfigDefinition): string {
    // Build CAIP-2 chain ID: namespace:reference
    const chainNamespace = config.network === 'SOLANA' ? 'solana' : 'eip155';
    const chainReference = config.chainId ||
        (config.network === 'BASE' ? '8453' :
            config.network === 'POLYGON' ? '137' : '1');
    const chainId = `${chainNamespace}:${chainReference}`;

    // Build asset part: namespace:reference
    const assetId = `${config.assetNamespace}:${config.assetReference}`;

    // Full CAIP-19: chain_id/asset_namespace:asset_reference
    return `${chainId}/${assetId}`;
}

/**
 * Mutable registry for custom payment configs
 * Plugins can register configs via registerX402Config()
 */
const CUSTOM_PAYMENT_CONFIGS: Record<string, PaymentConfigDefinition> = {};

/**
 * Register a custom payment configuration
 * Plugins call this in their init() function
 * 
 * @example
 * ```typescript
 * registerX402Config('base_ai16z', {
 *   network: 'BASE',
 *   assetNamespace: 'erc20',
 *   assetReference: '0x...',
 *   paymentAddress: process.env.BASE_PUBLIC_KEY,
 *   symbol: 'AI16Z',
 *   chainId: '8453'
 * });
 * 
 * // Agent-specific override
 * registerX402Config('base_usdc', {...}, { agentId: runtime.agentId });
 * ```
 */
export function registerX402Config(
    name: string,
    config: PaymentConfigDefinition,
    options?: { override?: boolean; agentId?: string }
): void {
    // Prevent accidental override of built-in configs
    if (PAYMENT_CONFIGS[name] && !options?.override) {
        throw new Error(
            `Payment config '${name}' already exists. Use override: true to replace it.`
        );
    }

    const registryKey = options?.agentId ? `${options.agentId}:${name}` : name;
    CUSTOM_PAYMENT_CONFIGS[registryKey] = config;

    console.log(`✓ Registered x402 payment config: ${registryKey} (${config.symbol} on ${config.network})`);
}

/**
 * Get payment config - checks custom registry then built-in
 * Supports agent-specific configs via agentId parameter
 */
export function getPaymentConfig(name: string, agentId?: string): PaymentConfigDefinition {
    // Check agent-specific config first
    if (agentId) {
        const agentConfig = CUSTOM_PAYMENT_CONFIGS[`${agentId}:${name}`];
        if (agentConfig) return agentConfig;
    }

    // Check custom global configs
    const customConfig = CUSTOM_PAYMENT_CONFIGS[name];
    if (customConfig) return customConfig;

    // Check built-in configs
    const builtInConfig = PAYMENT_CONFIGS[name];
    if (!builtInConfig) {
        const available = [
            ...Object.keys(PAYMENT_CONFIGS),
            ...Object.keys(CUSTOM_PAYMENT_CONFIGS).filter(k => !k.includes(':'))
        ];
        throw new Error(
            `Unknown payment config '${name}'. Available: ${available.join(', ')}`
        );
    }
    return builtInConfig;
}

/**
 * List all available payment configs (built-in + custom)
 * Optionally filter to agent-specific configs
 */
export function listX402Configs(agentId?: string): string[] {
    const configs = new Set([
        ...Object.keys(PAYMENT_CONFIGS),
        ...Object.keys(CUSTOM_PAYMENT_CONFIGS).filter(k => !k.includes(':'))
    ]);

    if (agentId) {
        Object.keys(CUSTOM_PAYMENT_CONFIGS)
            .filter(k => k.startsWith(`${agentId}:`))
            .forEach(k => configs.add(k.split(':')[1]));
    }

    return Array.from(configs).sort();
}

/**
 * Validate payment config name
 */
export function validatePaymentConfigName(name: string): boolean {
    return name in PAYMENT_CONFIGS;
}

// Re-export X402Config from core for convenience
export type { X402Config } from '@elizaos/core';

/**
 * Get the payment address for a specific network
 */
export function getPaymentAddress(network: Network): string {
    return PAYMENT_ADDRESSES[network] || PAYMENT_RECEIVER_ADDRESS;
}

/**
 * Get all network addresses with metadata
 */
export function getNetworkAddresses(networks: Network[]): Array<{
    name: Network;
    address: string;
    facilitatorEndpoint?: string;
}> {
    return networks.map(network => ({
        name: network,
        address: PAYMENT_ADDRESSES[network],
        // Add facilitator endpoint for EVM chains if configured
        ...((network === 'BASE' || network === 'POLYGON') && process.env.EVM_FACILITATOR && {
            facilitatorEndpoint: process.env.EVM_FACILITATOR
        })
    }));
}

/**
 * Token price configuration (USD per token)
 * In production, these should be fetched from an API like Birdeye or Jupiter
 */
export const TOKEN_PRICES_USD: Record<string, number> = {
    'USDC': 1.0,
    'ai16z': parseFloat(process.env.AI16Z_PRICE_USD || '0.50'),  // Default $0.50, set in .env
    'degenai': parseFloat(process.env.DEGENAI_PRICE_USD || '0.01'), // Default $0.01, set in .env
    'ETH': 2000.0 // Simplified, should be fetched dynamically
};

/**
 * Get token decimals for an asset
 */
function getTokenDecimals(asset: string, network?: Network): number {
    // Check network-specific tokens if network is provided
    if (network === 'SOLANA') {
        const solanaToken = Object.values(SOLANA_TOKENS).find(t => t.symbol === asset);
        if (solanaToken) return solanaToken.decimals;
    }
    if (network === 'BASE') {
        const baseToken = Object.values(BASE_TOKENS).find(t => t.symbol === asset);
        if (baseToken) return baseToken.decimals;
    }
    if (network === 'POLYGON') {
        const polygonToken = Object.values(POLYGON_TOKENS).find(t => t.symbol === asset);
        if (polygonToken) return polygonToken.decimals;
    }

    // Check all token configs if no network specified
    const solanaToken = Object.values(SOLANA_TOKENS).find(t => t.symbol === asset);
    if (solanaToken) return solanaToken.decimals;

    const baseToken = Object.values(BASE_TOKENS).find(t => t.symbol === asset);
    if (baseToken) return baseToken.decimals;

    const polygonToken = Object.values(POLYGON_TOKENS).find(t => t.symbol === asset);
    if (polygonToken) return polygonToken.decimals;

    // Defaults
    if (asset === 'USDC') return 6;
    if (asset === 'ETH') return 18;

    return 6; // Default to 6 decimals
}

/**
 * Parse price string (e.g., "$0.10") and convert to asset amount
 * For USDC, this is 1:1 with USD (6 decimals)
 * For other tokens, converts based on TOKEN_PRICES_USD
 * Returns the amount as a string in the smallest unit
 */
export function parsePrice(price: string, asset: string = 'USDC'): string {
    // Remove $ sign and parse as float
    const usdAmount = parseFloat(price.replace('$', ''));

    if (isNaN(usdAmount)) {
        throw new Error(`Invalid price format: ${price}`);
    }

    // Get token price in USD
    const tokenPriceUSD = TOKEN_PRICES_USD[asset] || 1.0;

    // Calculate amount of tokens needed
    const tokenAmount = usdAmount / tokenPriceUSD;

    // Get decimals for this token
    const decimals = getTokenDecimals(asset);

    // Convert to smallest unit
    const smallestUnit = Math.ceil(tokenAmount * Math.pow(10, decimals));

    return smallestUnit.toString();
}

/**
 * Get token address for a Solana token
 * @deprecated Use getTokenAddress instead
 */
export function getSolanaTokenAddress(asset: string): string | undefined {
    const token = Object.values(SOLANA_TOKENS).find(t => t.symbol === asset);
    return token?.address;
}

/**
 * Get token address for any network and asset
 */
export function getTokenAddress(asset: string, network: Network): string | undefined {
    if (network === 'SOLANA') {
        const token = Object.values(SOLANA_TOKENS).find(t => t.symbol === asset);
        return token?.address;
    }
    if (network === 'BASE') {
        const token = Object.values(BASE_TOKENS).find(t => t.symbol === asset);
        return token?.address;
    }
    if (network === 'POLYGON') {
        const token = Object.values(POLYGON_TOKENS).find(t => t.symbol === asset);
        return token?.address;
    }
    return undefined;
}

/**
 * Get the asset for a specific network
 */
export function getNetworkAsset(network: Network): string {
    return NETWORK_ASSETS[network];
}

/**
 * Get x402 system health status
 * Useful for monitoring and debugging
 */
export function getX402Health(): {
    networks: Array<{ network: Network; configured: boolean; address: string | null }>;
    facilitator: { url: string | null; configured: boolean };
} {
    const networks: Network[] = ['BASE', 'SOLANA', 'POLYGON'];

    return {
        networks: networks.map(network => ({
            network,
            configured: !!PAYMENT_ADDRESSES[network] && PAYMENT_ADDRESSES[network] !== '',
            address: PAYMENT_ADDRESSES[network] || null
        })),
        facilitator: {
            url: process.env.X402_FACILITATOR_URL || null,
            configured: !!process.env.X402_FACILITATOR_URL
        }
    };
}

