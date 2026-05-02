import type { TimeInterval } from "./common";

// Pair Trades Types
export interface PairTradesParams {
    pair: string;
    limit?: number;
    offset?: number;
}

export interface PairTradesResponse {
    success: boolean;
    data: {
        items: Array<{
            signature?: string;
            blockNumber?: number;
            unixTime?: number;
            type?: "buy" | "sell";
            tokenAddress?: string;
            tokenAmount?: number;
            tokenAmountUI?: number;
            tokenSymbol?: string;
            tokenDecimals?: number;
            priceUsd?: number;
            volumeUsd?: number;
            maker?: string;
            taker?: string;
            txType?: string;
            poolAddress?: string;
            poolName?: string;
            dex?: string;
        }>;
    };
}

// OHLCV Pair Types
export interface OHLCVPairParams {
    address: string;
    type?: TimeInterval;
    time_from?: number;
    time_to?: number;
}

export interface OHLCVPairResponse {
    success: boolean;
    data: {
        items: Array<{
            unixTime?: number;
            address?: string;
            type?: TimeInterval;
            o?: number;
            h?: number;
            l?: number;
            c?: number;
            v?: number;
        }>;
    };
}

// Pair Overview Types
export interface PairOverviewMultiParams {
    list_address: string;
    before_time?: number;
}

export interface PairOverviewSingleParams {
    address: string;
}

interface PairOverviewData {
    address: string;
    name: string;
    base: {
        address: string;
        decimals: number;
        icon: string;
        symbol: string;
    };
    quote: {
        address: string;
        decimals: number;
        icon: string;
        symbol: string;
    };
    created_at: string;
    source: string;
    liquidity: number;
    liquidity_change_percentage_24h: number | null;
    price: number;
    volume_24h: number;
    volume_24h_change_percentage_24h: number | null;
    trade_24h: number;
    trade_24h_change_percent: number;
    unique_wallet_24h: number;
    unique_wallet_24h_change_percent: number | null;

    // Time-based metrics
    trade_30m: number;
    trade_1h: number;
    trade_2h: number;
    trade_4h: number;
    trade_8h: number;
    trade_12h: number;

    trade_30m_change_percent: number;
    trade_1h_change_percent: number;
    trade_2h_change_percent: number;
    trade_4h_change_percent: number;
    trade_8h_change_percent: number;
    trade_12h_change_percent: number;

    volume_30m: number;
    volume_1h: number;
    volume_2h: number;
    volume_4h: number;
    volume_8h: number;
    volume_12h: number;

    volume_30m_quote: number;
    volume_1h_quote: number;
    volume_2h_quote: number;
    volume_4h_quote: number;
    volume_8h_quote: number;
    volume_12h_quote: number;

    volume_30m_base: number;
    volume_1h_base: number;
    volume_2h_base: number;
    volume_4h_base: number;
    volume_8h_base: number;
    volume_12h_base: number;
}

export interface PairOverviewSingleResponse {
    success: boolean;
    data: {
        address?: string;
        name?: string;
        base?: {
            address?: string;
            decimals?: number;
            icon?: string;
            symbol?: string;
        };
        quote?: {
            address?: string;
            decimals?: number;
            icon?: string;
            symbol?: string;
        };
        created_at?: string;
        source?: string;
        liquidity?: number;
        liquidity_change_percentage_24h?: number | null;
        price?: number;
        volume_24h?: number;
        volume_24h_change_percentage_24h?: number | null;
        trade_24h?: number;
        trade_24h_change_percent?: number;
        unique_wallet_24h?: number;
        unique_wallet_24h_change_percent?: number | null;
        trade_30m?: number;
        trade_1h?: number;
        trade_2h?: number;
        trade_4h?: number;
        trade_8h?: number;
        trade_12h?: number;
        trade_30m_change_percent?: number;
        trade_1h_change_percent?: number;
        trade_2h_change_percent?: number;
        trade_4h_change_percent?: number;
        trade_8h_change_percent?: number;
        trade_12h_change_percent?: number;
        volume_30m?: number;
        volume_1h?: number;
        volume_2h?: number;
        volume_4h?: number;
        volume_8h?: number;
        volume_12h?: number;
        volume_30m_quote?: number;
        volume_1h_quote?: number;
        volume_2h_quote?: number;
        volume_4h_quote?: number;
        volume_8h_quote?: number;
        volume_12h_quote?: number;
        volume_30m_base?: number;
        volume_1h_base?: number;
        volume_2h_base?: number;
        volume_4h_base?: number;
        volume_8h_base?: number;
        volume_12h_base?: number;
    };
}

export interface PairOverviewMultiResponse {
    success: boolean;
    data: {
        [pair: string]: PairOverviewData;
    };
}
