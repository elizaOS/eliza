import type { TimeInterval } from "./common";

// Network Types
export interface DefiNetworksResponse {
    success: boolean;
    data: {
        chains: string[];
    };
}

// Price Types
export interface DefiPriceParams {
    address: string;
    check_liquidity?: number;
    include_liquidity?: boolean;
}

export interface DefiPriceResponse {
    success: boolean;
    data: {
        value: number;
        updateUnixTime?: number;
        updateHumanTime?: string;
        liquidity?: number;
    };
}

// Multi Price Types
export interface DefiMultiPriceParams {
    list_address: string;
    check_liquidity?: number;
    include_liquidity?: boolean;
}

export interface DefiMultiPriceResponse {
    success: boolean;
    data: {
        [address: string]: {
            value?: number;
            updateUnixTime?: number;
            updateHumanTime?: string;
            priceChange24h?: number;
        };
    };
}

// Multi Price Types POST
export interface DefiMultiPriceParamsPOST {
    check_liquidity?: number;
    include_liquidity?: boolean;
    list_address: string;
}

// History Price Types
export interface DefiHistoryPriceParams {
    address: string;
    address_type: "token" | "pair";
    type: TimeInterval;
    time_from?: number;
    time_to?: number;
}

export interface DefiHistoryPriceResponse {
    success: boolean;
    data: {
        items: Array<{
            unixTime?: number;
            value?: number;
        }>;
    };
}

// Historical Price Unix Types
export interface HistoricalPriceUnixParams {
    address: string;
    unixtime?: number;
}

export interface HistoricalPriceUnixResponse {
    success: boolean;
    data: {
        value?: number;
        updateUnixTime?: number;
        priceChange24h?: string;
    };
}

// OHLCV Types
export interface OHLCVParams {
    address: string;
    type?: TimeInterval;
    time_from?: number;
    time_to?: number;
}

export interface OHLCVResponse {
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

// Price Volume Types
export interface PriceVolumeParams {
    address: string;
    type?: TimeInterval;
}

export interface PriceVolumeResponse {
    success: boolean;
    data: {
        price?: number;
        updateUnixTime?: number;
        updateHumanTime?: string;
        volumeUSD?: number;
        volumeChangePercent?: number;
        priceChangePercent?: number;
    };
}

// Multi Price Volume Types
export interface MultiPriceVolumeParams {
    list_address: string;
    type?: TimeInterval;
}

export interface MultiPriceVolumeResponse {
    success: boolean;
    data: {
        [address: string]: {
            price?: number;
            updateUnixTime?: number;
            updateHumanTime?: string;
            volumeUSD?: number;
            volumeChangePercent?: number;
            priceChangePercent?: number;
        };
    };
}

// Base Quote Types
export interface BaseQuoteParams {
    base_address: string;
    quote_address: string;
    type?: TimeInterval;
    time_from?: number;
    time_to?: number;
}

export interface BaseQuoteResponse {
    success: boolean;
    data: {
        unixTime?: number;
        vBase?: number;
        vQuote?: number;
        o?: number;
        h?: number;
        l?: number;
        c?: number;
    };
}

// Token Trades Types
export interface DefiTradesTokenParams {
    address: string;
    limit?: number;
    offset?: number;
    tx_type?: "swap" | "add" | "remove" | "all";
    sort_type?: "asc" | "desc";
    before_time?: number;
    after_time?: number;
}

export interface DefiTradesTokenInfo {
    symbol: string;
    decimals: number;
    address: string;
    amount: number;
    uiAmount: number;
    price: number | null;
    nearestPrice: number | null;
    changeAmount: number;
    uiChangeAmount: number;
    feeInfo?: any | null;
}

export interface DefiTradesTokenResponse {
    success: boolean;
    data: {
        items: Array<{
            quote?: DefiTradesTokenInfo;
            base?: DefiTradesTokenInfo;
            basePrice?: number | null;
            quotePrice?: number | null;
            txHash?: string;
            source?: string;
            blockUnixTime?: number;
            txType?: string;
            owner?: string;
            side?: string;
            alias?: string | null;
            pricePair?: number;
            from?: DefiTradesTokenInfo;
            to?: DefiTradesTokenInfo;
            tokenPrice?: number | null;
            poolId?: string;
        }>;
        hasNext?: boolean;
    };
}
