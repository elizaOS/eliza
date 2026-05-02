import type { BirdeyeSupportedChain } from "../shared";

// Search Types
export interface TokenMarketSearchParams {
    chain?: BirdeyeSupportedChain | "all";
    keyword?: string;
    target?: "token" | "market" | "all";
    sort_by?:
        | "fdv"
        | "marketcap"
        | "liquidity"
        | "price"
        | "price_change_24h_percent"
        | "trade_24h"
        | "trade_24h_change_percent"
        | "buy_24h"
        | "buy_24h_change_percent"
        | "sell_24h"
        | "sell_24h_change_percent"
        | "unique_wallet_24h"
        | "unique_view_24h_change_percent"
        | "last_trade_unix_time"
        | "volume_24h_usd"
        | "volume_24h_change_percent";
    sort_type?: "asc" | "desc";
    verify_token?: boolean;
    markets?: string;
    offset?: number;
    limit?: number;
}

export interface TokenMarketSearchResponse {
    success: boolean;
    data: {
        items: Array<{
            type?: "token" | "market";
            result?: Array<TokenResult | MarketResult>;
        }>;
    };
}

export interface TokenResult {
    name?: string;
    symbol?: string;
    address?: string;
    network?: string;
    fdv?: number;
    market_cap?: number;
    liquidity?: number;
    volume_24h_change_percent?: number;
    price?: number;
    price_change_24h_percent?: number;
    buy_24h?: number;
    buy_24h_change_percent?: number;
    sell_24h?: number;
    sell_24h_change_percent?: number;
    trade_24h?: number;
    trade_24h_change_percent?: number;
    unique_wallet_24h?: number;
    unique_view_24h_change_percent?: number;
    last_trade_human_time?: string;
    last_trade_unix_time?: number;
    creation_time?: string;
    volume_24h_usd?: number;
    logo_uri?: string;
}

export interface MarketResult {
    name: string;
    address: string;
    liquidity: number;
    source: string;
    trade_24h: number;
    trade_24h_change_percent: number;
    unique_wallet_24h: number;
    unique_wallet_24h_change_percent: number;
    last_trade_human_time: string;
    last_trade_unix_time: number;
    base_mint: string;
    quote_mint: string;
    amount_base: number;
    amout_quote: number; // Note: typo in API response
    creation_time: string;
    volume_24h_usd: number;
}
