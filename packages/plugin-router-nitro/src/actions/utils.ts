import axios from "axios";
interface ChainData {
    name: string;
    chainId: string;
    type: string;
    isLive: boolean;
    gasToken?: {
        symbol: string;
        address: string;
    };
}

interface TokenData {
    address: string;
    name: string;
    decimals: number;
    chainId: number;
}

export class ChainUtils {
    private chainData: ChainData[] = [];
    private chainNameMappings: { [key: string]: string[] } = {
        'arbitrum': ['arbitrum', 'arbitrum one', 'arb', 'arbitrum mainnet'],
        'ethereum': ['ethereum', 'eth', 'ethereum mainnet', 'ether'],
        'polygon': ['polygon', 'matic', 'polygon mainnet', 'polygon pos'],
        'avalanche': ['avalanche', 'avax', 'avalanche c-chain', 'avalanche mainnet'],
        'binance': ['binance', 'bsc', 'bnb', 'bnb smart chain', 'bnb smart chain mainnet'],
        'optimism': ['optimism', 'op', 'op mainnet'],
        'base': ['base', 'base mainnet'],
        'zksync': ['zksync', 'zksync era', 'zksync mainnet'],
        'manta': ['manta', 'manta pacific', 'manta pacific mainnet'],
        'mantle': ['mantle', 'mantle mainnet'],
        'linea': ['linea', 'linea mainnet'],
        'scroll': ['scroll', 'scroll mainnet'],
        'mode': ['mode', 'mode mainnet'],
        'blast': ['blast', 'blast mainnet'],
        'polygon-zkevm': ['polygon zkevm', 'polygon zkvm', 'zkevm'],
        'boba': ['boba', 'boba network'],
        'metis': ['metis', 'metis andromeda', 'metis mainnet'],
        'aurora': ['aurora', 'aurora mainnet'],
        'taiko': ['taiko', 'taiko mainnet'],
        'rootstock': ['rootstock', 'rsk', 'rootstock mainnet'],
        'dogechain': ['dogechain', 'dogechain mainnet'],
        'oasis-sapphire': ['oasis sapphire', 'sapphire'],
        'xlayer': ['x layer', 'xlayer mainnet'],
        'rollux': ['rollux', 'rollux mainnet'],
        '5ire': ['5ire', '5irechain', '5irechain mainnet'],
        'kyoto': ['kyoto', 'kyoto mainnet'],
        'vanar': ['vanar', 'vanar mainnet'],
        'saakuru': ['saakuru', 'saakuru mainnet'],
        'redbelly': ['redbelly', 'redbelly mainnet'],
        'shido': ['shido', 'shido mainnet'],
        'nero': ['nero', 'nero mainnet'],
        'soneium': ['soneium', 'soneium mainnet'],
        'hyperliquid': ['hyperliquid', 'hyperliquid mainnet'],
        'arthera': ['arthera', 'arthera mainnet']
    };

    constructor(apiResponse: { data: ChainData[] }) {
        this.chainData = apiResponse.data;
    }

    private normalizeChainName(input: string): string {
        const normalized = input.toLowerCase().trim();

        // Iterate through chainNameMappings to find a match
        for (const [standardName, aliases] of Object.entries(this.chainNameMappings)) {
            if (aliases.includes(normalized)) {
                const chainMatch = this.chainData.find(chain =>
                    aliases.includes(chain.name.toLowerCase()) || chain.name.toLowerCase().includes(standardName) // Match standard name
                );

                if (chainMatch) {
                    return chainMatch.name;
                }
            }
        }

        const partialMatch = this.chainData.find(chain =>
            chain.name.toLowerCase().includes(normalized) ||
            normalized.includes(chain.name.toLowerCase())
        );

        if (partialMatch) {
            return partialMatch.name;
        }

        return input;
    }


    getChainId(chainName: string): string | null {
        if (!chainName) return null;

        const normalizedName = this.normalizeChainName(chainName);
        const chain = this.chainData.find(
            c => c.name.toLowerCase() === normalizedName.toLowerCase()
        );

        return chain ? chain.chainId : null;
    }

    getChainType(chainName: string): string | null {
        if (!chainName) return null;

        const normalizedName = this.normalizeChainName(chainName);
        const chain = this.chainData.find(
            c => c.name.toLowerCase() === normalizedName.toLowerCase()
        );

        return chain ? chain.type : null;
    }

    isChainLive(chainName: string): boolean {
        if (!chainName) return false;

        const normalizedName = this.normalizeChainName(chainName);
        const chain = this.chainData.find(
            c => c.name.toLowerCase() === normalizedName.toLowerCase()
        );

        return chain ? chain.isLive : false;
    }

    getGasToken(chainName: string): { symbol: string; address: string; } | null {
        if (!chainName) return null;

        const normalizedName = this.normalizeChainName(chainName);
        const chain = this.chainData.find(
            c => c.name.toLowerCase() === normalizedName.toLowerCase()
        );

        return chain?.gasToken || null;
    }

    validateChain(chainName: string): {
        isValid: boolean;
        chainId: string | null;
        isLive: boolean;
        type: string | null;
        normalizedName: string;
        message?: string;
    } {
        if (!chainName) {
            return {
                isValid: false,
                chainId: null,
                isLive: false,
                type: null,
                normalizedName: '',
                message: 'Chain name is required'
            };
        }

        const normalizedName = this.normalizeChainName(chainName);
        const chainId = this.getChainId(normalizedName);
        const isLive = this.isChainLive(normalizedName);
        const type = this.getChainType(normalizedName);

        const isValid = chainId !== null;

        return {
            isValid,
            chainId,
            isLive,
            type,
            normalizedName,
            message: isValid
                ? undefined
                : `Invalid chain name: ${chainName}`
        };
    }

    processChainSwap(fromChain: string, toChain: string): {
        fromChainId: string | null;
        toChainId: string | null;
    } {
        const sourceChain = this.validateChain(fromChain);
        const destChain = this.validateChain(toChain);

        if (!sourceChain.isValid) {
            throw new Error(`Invalid source chain: ${fromChain}`);
        }

        if (!destChain.isValid) {
            throw new Error(`Invalid destination chain: ${toChain}`);
        }

        if (!sourceChain.isLive) {
            throw new Error(`Source chain ${sourceChain.normalizedName} is not currently active`);
        }

        if (!destChain.isLive) {
            throw new Error(`Destination chain ${destChain.normalizedName} is not currently active`);
        }

        return {
            fromChainId: sourceChain.chainId,
            toChainId: destChain.chainId
        };
    }
}

export async function fetchChains(): Promise<{ data: ChainData[] }> {
    const url = 'https://api.nitroswap.routernitro.com/chain?page=0&limit=10000';

    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('Error fetching chains:', error);
        throw new Error('Failed to fetch chains.');
    }
}

const tokenCache: { [key: string]: TokenData } = {};

export async function fetchTokenConfig(chainId: number, token: string): Promise<TokenData> {
    const cacheKey = `${chainId}-${token.toLowerCase()}`;

    // Check if the token config is already cached
    if (tokenCache[cacheKey]) {
        console.log(`Cache hit for ${cacheKey}`);
        return tokenCache[cacheKey];
    }

    // prioritizing lowercase first
    const tokenCases = [token.toLowerCase(), token.toUpperCase()];

    for (const tokenSymbol of tokenCases) {
        const url = `https://api.nitroswap.routernitro.com/token?&chainId=${chainId}&symbol=${tokenSymbol}`;
        try {
            const response = await axios.get(url);

            const tokenData = response.data?.data?.[0];
            if (tokenData) {
                tokenCache[cacheKey] = {
                    address: tokenData.address,
                    name: tokenData.name,
                    decimals: tokenData.decimals,
                    chainId: tokenData.chainId,
                };
                return tokenCache[cacheKey];
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error 
                ? error.message 
                : 'Unknown error occurred';
            console.warn(`Error with token symbol "${tokenSymbol}": ${errorMessage}`);
        }
    }

    throw new Error(`Failed to fetch token config for "${token}" on chainId "${chainId}"`);
}

interface PathfinderQuoteParams {
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    fromTokenChainId: number;
    toTokenChainId: number;
    partnerId: number;
}

export async function fetchPathfinderQuote(params: PathfinderQuoteParams): Promise<unknown> {
    const { fromTokenAddress, toTokenAddress, amount, fromTokenChainId, toTokenChainId, partnerId } = params;

    const pathfinderUrl = `https://api-beta.pathfinder.routerprotocol.com/api/v2/quote?fromTokenAddress=${fromTokenAddress}&toTokenAddress=${toTokenAddress}&amount=${amount}&fromTokenChainId=${fromTokenChainId}&toTokenChainId=${toTokenChainId}&partnerId=${partnerId}`;

    try {
        const response = await axios.get(pathfinderUrl);
        return response.data;
    } catch (error) {
        console.error("Error fetching Pathfinder quote:", error instanceof Error ? error.message : String(error));
        throw new Error(`Pathfinder API call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}


// export async function fetchPathfinderQuote(params: PathfinderQuoteParams): Promise<any> {
//     const { fromTokenAddress, toTokenAddress, amount, fromTokenChainId, toTokenChainId, partnerId } = params;

//     const pathfinderUrl = `https://api-beta.pathfinder.routerprotocol.com/api/v2/quote` +
//         `?fromTokenAddress=${fromTokenAddress}` +
//         `&toTokenAddress=${toTokenAddress}` +
//         `&amount=${amount}` +
//         `&fromTokenChainId=${fromTokenChainId}` +
//         `&toTokenChainId=${toTokenChainId}` +
//         `&partnerId=${partnerId}`;

//     try {
//         const response = await axios.get(pathfinderUrl);
//         return response.data;
//     } catch (error) {
//         console.error("Error fetching Pathfinder quote:", error.message);
//         throw new Error(`Pathfinder API call failed: ${error.message}`);
//     }
// }
