// ------------------------------------------------------------------------------------------------
// Essential Imports
// ------------------------------------------------------------------------------------------------
import { elizaLogger } from "@elizaos/core";
import { APIError, ValidationError } from '../error/base';

// ------------------------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------------------------
interface ParsedAPIContent {
    wallet?: string;
    chain?: string;
    contract?: string;
    token?: string;
    txHash?: string;
    block?: string;
    block2?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
    raw: {
        text: string;
        matches: {
            wallet: boolean;
            chain: boolean;
            contract: boolean;
            token: boolean;
            txHash: boolean;
            block: boolean;
            block2: boolean;
            fromTimestamp: boolean;
            toTimestamp: boolean;
        };
    };
}

// ------------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------------
const SUPPORTED_CHAINS = [
    'eth', 'ethereum',
    'bsc', 'bnb',
    'polygon', 'matic',
    'avalanche', 'avax',
    'optimism', 'op',
    'base'
];

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

// ------------------------------------------------------------------------------------------------
// Helper Functions
// ------------------------------------------------------------------------------------------------
const normalizeChainName = (chain: string): string => {
    chain = chain.toLowerCase().trim();
    switch (chain) {
        case 'eth':
        case 'ethereum':
            return 'eth';
        case 'bsc':
        case 'bnb':
            return 'bsc';
        case 'polygon':
        case 'matic':
            return 'polygon';
        case 'avalanche':
        case 'avax':
            return 'avalanche';
        case 'optimism':
        case 'op':
            return 'optimism';
        case 'base':
            return 'base';
        default:
            throw new ValidationError(`Unsupported blockchain: ${chain}`);
    }
};

const validateAddress = (address: string): boolean => {
    return ADDRESS_REGEX.test(address);
};

const validateTxHash = (hash: string): boolean => {
    return TX_HASH_REGEX.test(hash);
};

// Add block number validation
const validateBlockNumber = (block: string): boolean => {
    return /^\d+$/.test(block);
};

// Add timestamp validation
const validateTimestamp = (timestamp: string): boolean => {
    const num = parseInt(timestamp, 10);
    return !isNaN(num) && num > 0;
};

// Add token ID validation
const validateTokenId = (tokenId: string): boolean => {
    return tokenId.trim() !== '';  // Just ensure it's not empty
};

// ------------------------------------------------------------------------------------------------
// Main Parser
// ------------------------------------------------------------------------------------------------
/**
 * Parses API-related content from text, extracting wallet addresses, chain names,
 * contract addresses, token addresses, and transaction hashes.
 *
 * @param text The input text containing tagged content
 * @returns ParsedAPIContent object containing extracted and validated information
 *
 * @example
 * Input text: "Check balance for [wallet]0x123...[/wallet] on [chain]eth[/chain]"
 */
export function parseAPIContent(text: string): ParsedAPIContent {
    try {
        const parsed: ParsedAPIContent = {
            raw: {
                text,
                matches: {
                    wallet: false,
                    chain: false,
                    contract: false,
                    token: false,
                    txHash: false,
                    block: false,
                    block2: false,
                    fromTimestamp: false,
                    toTimestamp: false
                }
            }
        };

        // Parse wallet address
        const walletMatch = text.match(/\[wallet\]([\s\S]*?)\[\/wallet\]/);
        if (walletMatch) {
            const wallet = walletMatch[1].trim();
            if (!validateAddress(wallet)) {
                throw new ValidationError(`Invalid wallet address: ${wallet}`);
            }
            parsed.wallet = wallet;
            parsed.raw.matches.wallet = true;
        }

        // Parse chain name
        const chainMatch = text.match(/\[chain\]([\s\S]*?)\[\/chain\]/);
        if (chainMatch) {
            const chain = chainMatch[1].trim();
            parsed.chain = normalizeChainName(chain);
            parsed.raw.matches.chain = true;
        }

        // Parse contract address
        const contractMatch = text.match(/\[contract\]([\s\S]*?)\[\/contract\]/);
        if (contractMatch) {
            const contract = contractMatch[1].trim();
            if (!validateAddress(contract)) {
                throw new ValidationError(`Invalid contract address: ${contract}`);
            }
            parsed.contract = contract;
            parsed.raw.matches.contract = true;
        }

        // Parse token ID (modified from token address)
        const tokenMatch = text.match(/\[token\]([\s\S]*?)\[\/token\]/);
        if (tokenMatch) {
            const token = tokenMatch[1].trim();
            if (!validateTokenId(token)) {
                throw new ValidationError(`Invalid token ID: ${token}`);
            }
            parsed.token = token;
            parsed.raw.matches.token = true;
        }

        // Parse transaction hash
        const txMatch = text.match(/\[txHash\]([\s\S]*?)\[\/txHash\]/);
        if (txMatch) {
            const txHash = txMatch[1].trim();
            if (!validateTxHash(txHash)) {
                throw new ValidationError(`Invalid transaction hash: ${txHash}`);
            }
            parsed.txHash = txHash;
            parsed.raw.matches.txHash = true;
        }

        // Parse block number
        const blockMatch = text.match(/\[block\]([\s\S]*?)\[\/block\]/);
        if (blockMatch) {
            const block = blockMatch[1].trim();
            if (!validateBlockNumber(block)) {
                throw new ValidationError(`Invalid block number: ${block}`);
            }
            parsed.block = block;
            parsed.raw.matches.block = true;
        }

        // Parse second block number if present
        const block2Match = text.match(/\[block2\]([\s\S]*?)\[\/block2\]/);
        if (block2Match) {
            const block2 = block2Match[1].trim();
            if (!validateBlockNumber(block2)) {
                throw new ValidationError(`Invalid block number: ${block2}`);
            }
            parsed.block2 = block2;
            parsed.raw.matches.block2 = true;
        }

        // Parse fromTimestamp
        const fromTimestampMatch = text.match(/\[fromtimestamp\]([\s\S]*?)\[\/fromtimestamp\]/);
        if (fromTimestampMatch) {
            const timestamp = fromTimestampMatch[1].trim();
            if (!validateTimestamp(timestamp)) {
                throw new ValidationError(`Invalid from timestamp: ${timestamp}`);
            }
            parsed.fromTimestamp = parseInt(timestamp, 10);
            parsed.raw.matches.fromTimestamp = true;
        }

        // Parse toTimestamp
        const toTimestampMatch = text.match(/\[totimestamp\]([\s\S]*?)\[\/totimestamp\]/);
        if (toTimestampMatch) {
            const timestamp = toTimestampMatch[1].trim();
            if (!validateTimestamp(timestamp)) {
                throw new ValidationError(`Invalid to timestamp: ${timestamp}`);
            }
            parsed.toTimestamp = parseInt(timestamp, 10);
            parsed.raw.matches.toTimestamp = true;
        }

        return parsed;

    } catch (error) {
        elizaLogger.error("API content parsing failed", {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

// ------------------------------------------------------------------------------------------------
// Validation Helpers
// ------------------------------------------------------------------------------------------------
export function validateRequiredFields(
    parsed: ParsedAPIContent,
    required: Array<keyof ParsedAPIContent['raw']['matches']>
): void {
    const missing = required.filter(field => !parsed.raw.matches[field]);
    if (missing.length > 0) {
        throw new ValidationError(
            `Missing required fields: ${missing.join(', ')}. Please provide them in the format [field]value[/field]`
        );
    }
}

export function validateChainSupport(chain: string): void {
    if (!SUPPORTED_CHAINS.includes(chain.toLowerCase())) {
        throw new ValidationError(
            `Unsupported blockchain: ${chain}. Supported chains: ${SUPPORTED_CHAINS.join(', ')}`
        );
    }
}