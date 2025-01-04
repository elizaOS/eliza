// Type definitions for CoinGecko plugin

export interface CoinGeckoConfig {
    apiKey?: string;
}

export interface PriceResponse {
    [key: string]: {
        [currency: string]: number;
    };
}

export interface MarketData {
    id: string;
    symbol: string;
    name: string;
    current_price: number;
    market_cap: number;
    market_cap_rank: number;
    price_change_percentage_24h: number;
    total_volume: number;
}
