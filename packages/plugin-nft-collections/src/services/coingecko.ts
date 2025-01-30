interface CoinGeckoNFTData {
    id: string;
    contract_address: string;
    name: string;
    asset_platform_id: string;
    symbol: string;
    market_cap_usd?: number;
    volume_24h_usd?: number;
    floor_price_usd?: number;
    floor_price_eth?: number;
    total_supply?: number;
    market_cap_eth?: number;
    volume_24h_eth?: number;
    number_of_unique_addresses?: number;
    number_of_unique_currencies?: number;
}

interface GlobalNFTStats {
    data: {
        total_market_cap_usd: number;
        total_volume_24h_usd: number;
        market_cap_change_24h: number;
        volume_change_24h: number;
        number_of_unique_currencies: number;
        number_of_unique_addresses: number;
    };
}

export class CoinGeckoService {
    private baseUrl = "https://api.coingecko.com/api/v3";
    private apiKey?: string;

    constructor(apiKey?: string) {
        this.apiKey = apiKey;
    }

    private async fetch<T>(
        endpoint: string,
        params: Record<string, string | number | boolean> = {}
    ): Promise<T> {
        if (this.apiKey) {
            params.x_cg_pro_api_key = this.apiKey;
        }

        const queryString = new URLSearchParams(
            Object.fromEntries(
                Object.entries(params).map(([key, value]) => [key, String(value)])
            )
        ).toString();

        const url = `${this.baseUrl}${endpoint}${queryString ? `?${queryString}` : ""}`;

        const response = await fetch(url, {
            headers: {
                accept: "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`CoinGecko API error: ${response.statusText}`);
        }

        return response.json();
    }

    async getNFTMarketData(
        contractAddress: string
    ): Promise<CoinGeckoNFTData | null> {
        try {
            const data = await this.fetch<CoinGeckoNFTData[]>("/nfts/list");
            const nft = data.find(
                (n) =>
                    n.contract_address.toLowerCase() ===
                    contractAddress.toLowerCase()
            );

            if (!nft) return null;

            // Get detailed data
            const details = await this.fetch<CoinGeckoNFTData>(
                `/nfts/${nft.id}`
            );
            return details;
        } catch (error) {
            console.error("Error fetching CoinGecko data:", error);
            return null;
        }
    }

    async getGlobalNFTStats(): Promise<{
        total_market_cap_usd: number;
        total_volume_24h_usd: number;
        market_cap_change_24h: number;
        volume_change_24h: number;
        number_of_unique_currencies: number;
        number_of_unique_addresses: number;
    }> {
        const data = await this.fetch<GlobalNFTStats>("/global/nft");
        return data.data;
    }

    async getTrendingCollections(): Promise<CoinGeckoNFTData[]> {
        const data = await this.fetch<CoinGeckoNFTData[]>("/nfts/list", {
            order: "market_cap_usd_desc",
            per_page: "20",
            page: "1",
        });
        return data;
    }
}
