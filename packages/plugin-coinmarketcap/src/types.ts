import { Content } from "@elizaos/core";

export interface GetPriceContent extends Content {
    symbol: string;
    currency: string;
}

export interface PriceData {
    price: number;
    marketCap: number;
    volume24h: number;
    percentChange24h: number;
}

export interface ApiResponse {
    data: {
        [symbol: string]: {
            quote: {
                [currency: string]: {
                    price: number;
                    market_cap: number;
                    volume_24h: number;
                    percent_change_24h: number;
                };
            };
        };
    };
}
