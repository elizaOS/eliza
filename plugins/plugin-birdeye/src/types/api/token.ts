import type { TimeInterval, TokenTradeData } from "./common";

// Token Trades Types
export interface TokenTradesParams {
    address: string;
    limit?: number;
    offset?: number;
    type?: "buy" | "sell" | "all";
}

export interface TokenTradesResponse {
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

export interface TokenListParams {
    sort_by?: "mc" | "v24hUSD" | "v24hChangePercent";
    sort_type?: "asc" | "desc";
    offset?: number;
    limit?: number;
    min_liquidity?: number;
}

// Token List Types
export interface TokenListResponse {
    success: boolean;
    data: {
        tokens: Array<{
            address?: string;
            symbol?: string;
            name?: string;
            decimals?: number;
            logoURI?: string;
            coingeckoId?: string;
            volume24h?: number;
            priceChange24h?: number;
            price?: number;
        }>;
    };
}

// Token Security Types
export interface TokenSecurityParams {
    address: string;
}

export interface TokenSecurityResponse {
    success: boolean;
    data: {
        address?: string;
        totalSupply?: number;
        mintable?: boolean;
        proxied?: boolean;
        proxy?: string;
        ownerAddress?: string;
        creatorAddress?: string;
        securityChecks?: {
            honeypot?: boolean;
            trading_cooldown?: boolean;
            transfer_pausable?: boolean;
            is_blacklisted?: boolean;
            is_whitelisted?: boolean;
            is_proxy?: boolean;
            is_mintable?: boolean;
            can_take_back_ownership?: boolean;
            hidden_owner?: boolean;
            anti_whale_modifiable?: boolean;
            is_anti_whale?: boolean;
            trading_pausable?: boolean;
            can_be_blacklisted?: boolean;
            is_true_token?: boolean;
            is_airdrop_scam?: boolean;
            slippage_modifiable?: boolean;
            is_honeypot?: boolean;
            transfer_pausable_time?: boolean;
            is_wrapped?: boolean;
        };
    };
}

// Token Overview Types
export interface TokenOverviewParams {
    address: string;
}

export interface TokenOverviewResponse {
    success: boolean;
    data: {
        address?: string;
        decimals?: number;
        symbol?: string;
        name?: string;
        extensions?: {
            coingeckoId?: string;
            serumV3Usdc?: string;
            serumV3Usdt?: string;
            website?: string;
            telegram?: string | null;
            twitter?: string;
            description?: string;
            discord?: string;
            medium?: string;
        };
        logoURI?: string;
        liquidity?: number;
        lastTradeUnixTime?: number;
        lastTradeHumanTime?: string;
        price?: number;
        history30mPrice?: number;
        priceChange30mPercent?: number;
        history1hPrice?: number;
        priceChange1hPercent?: number;
        history2hPrice?: number;
        priceChange2hPercent?: number;
        history4hPrice?: number;
        priceChange4hPercent?: number;
        history6hPrice?: number;
        priceChange6hPercent?: number;
        history8hPrice?: number;
        priceChange8hPercent?: number;
        history12hPrice?: number;
        priceChange12hPercent?: number;
        history24hPrice?: number;
        priceChange24hPercent?: number;
        uniqueWallet30m?: number;
        uniqueWalletHistory30m?: number;
        uniqueWallet30mChangePercent?: number;
        uniqueWallet1h?: number;
        uniqueWalletHistory1h?: number;
        uniqueWallet1hChangePercent?: number;
        uniqueWallet2h?: number;
        uniqueWalletHistory2h?: number;
        uniqueWallet2hChangePercent?: number;
        uniqueWallet4h?: number;
        uniqueWalletHistory4h?: number;
        uniqueWallet4hChangePercent?: number;
        uniqueWallet8h?: number;
        uniqueWalletHistory8h?: number;
        uniqueWallet8hChangePercent?: number;
        uniqueWallet24h?: number;
        uniqueWalletHistory24h?: number;
        uniqueWallet24hChangePercent?: number;
        supply?: number;
        mc?: number;
        circulatingSupply?: number;
        realMc?: number;
        holder?: number;
        trade30m?: number;
        tradeHistory30m?: number;
        trade30mChangePercent?: number;
        sell30m?: number;
        sellHistory30m?: number;
        sell30mChangePercent?: number;
        buy30m?: number;
        buyHistory30m?: number;
        buy30mChangePercent?: number;
        v30m?: number;
        v30mUSD?: number;
        vHistory30m?: number;
        vHistory30mUSD?: number;
        v30mChangePercent?: number;
        vBuy30m?: number;
        vBuy30mUSD?: number;
        vBuyHistory30m?: number;
        vBuyHistory30mUSD?: number;
        vBuy30mChangePercent?: number;
        vSell30m?: number;
        vSell30mUSD?: number;
        vSellHistory30m?: number;
        vSellHistory30mUSD?: number;
        vSell30mChangePercent?: number;
        trade1h?: number;
        tradeHistory1h?: number;
        trade1hChangePercent?: number;
        sell1h?: number;
        sellHistory1h?: number;
        sell1hChangePercent?: number;
        buy1h?: number;
        buyHistory1h?: number;
        buy1hChangePercent?: number;
        v1h?: number;
        v1hUSD?: number;
        vHistory1h?: number;
        vHistory1hUSD?: number;
        v1hChangePercent?: number;
        vBuy1h?: number;
        vBuy1hUSD?: number;
        vBuyHistory1h?: number;
        vBuyHistory1hUSD?: number;
        vBuy1hChangePercent?: number;
        vSell1h?: number;
        vSell1hUSD?: number;
        vSellHistory1h?: number;
        vSellHistory1hUSD?: number;
        vSell1hChangePercent?: number;
        trade2h?: number;
        tradeHistory2h?: number;
        trade2hChangePercent?: number;
        sell2h?: number;
        sellHistory2h?: number;
        sell2hChangePercent?: number;
        buy2h?: number;
        buyHistory2h?: number;
        buy2hChangePercent?: number;
        v2h?: number;
        v2hUSD?: number;
        vHistory2h?: number;
        vHistory2hUSD?: number;
        v2hChangePercent?: number;
        vBuy2h?: number;
        vBuy2hUSD?: number;
        vBuyHistory2h?: number;
        vBuyHistory2hUSD?: number;
        vBuy2hChangePercent?: number;
        vSell2h?: number;
        vSell2hUSD?: number;
        vSellHistory2h?: number;
        vSellHistory2hUSD?: number;
        vSell2hChangePercent?: number;
        trade4h?: number;
        tradeHistory4h?: number;
        trade4hChangePercent?: number;
        sell4h?: number;
        sellHistory4h?: number;
        sell4hChangePercent?: number;
        buy4h?: number;
        buyHistory4h?: number;
        buy4hChangePercent?: number;
        v4h?: number;
        v4hUSD?: number;
        vHistory4h?: number;
        vHistory4hUSD?: number;
        v4hChangePercent?: number;
        vBuy4h?: number;
        vBuy4hUSD?: number;
        vBuyHistory4h?: number;
        vBuyHistory4hUSD?: number;
        vBuy4hChangePercent?: number;
        vSell4h?: number;
        vSell4hUSD?: number;
        vSellHistory4h?: number;
        vSellHistory4hUSD?: number;
        vSell4hChangePercent?: number;
        trade8h?: number;
        tradeHistory8h?: number;
        trade8hChangePercent?: number;
        sell8h?: number;
        sellHistory8h?: number;
        sell8hChangePercent?: number;
        buy8h?: number;
        buyHistory8h?: number;
        buy8hChangePercent?: number;
        v8h?: number;
        v8hUSD?: number;
        vHistory8h?: number;
        vHistory8hUSD?: number;
        v8hChangePercent?: number;
        vBuy8h?: number;
        vBuy8hUSD?: number;
        vBuyHistory8h?: number;
        vBuyHistory8hUSD?: number;
        vBuy8hChangePercent?: number;
        vSell8h?: number;
        vSell8hUSD?: number;
        vSellHistory8h?: number;
        vSellHistory8hUSD?: number;
        vSell8hChangePercent?: number;
        trade24h?: number;
        tradeHistory24h?: number;
        trade24hChangePercent?: number;
        sell24h?: number;
        sellHistory24h?: number;
        sell24hChangePercent?: number;
        buy24h?: number;
        buyHistory24h?: number;
        buy24hChangePercent?: number;
        v24h?: number;
        v24hUSD?: number;
        vHistory24h?: number;
        vHistory24hUSD?: number;
        v24hChangePercent?: number;
        vBuy24h?: number;
        vBuy24hUSD?: number;
        vBuyHistory24h?: number;
        vBuyHistory24hUSD?: number;
        vBuy24hChangePercent?: number;
        vSell24h?: number;
        vSell24hUSD?: number;
        vSellHistory24h?: number;
        vSellHistory24hUSD?: number;
        vSell24hChangePercent?: number;
        watch?: null;
        numberMarkets?: number;
    };
}

// Token Creation Info Types
export interface TokenCreationInfoParams {
    address: string;
}

export interface TokenCreationInfoResponse {
    success: boolean;
    data: {
        txHash?: string;
        slot?: number;
        tokenAddress?: string;
        decimals?: number;
        owner?: string;
        blockUnixTime?: number;
        blockHumanTime?: string;
    };
}

export interface TokenTrendingParams {
    sort_by?: "rank" | "volume24hUSD" | "liquidity";
    sort_type?: "asc" | "desc";
    offset?: number;
    limit?: number;
}

// Token Trending Types
export interface TokenTrendingResponse {
    success: boolean;
    data: {
        updateUnixTime?: number;
        updateTime?: string;
        tokens: Array<{
            address?: string;
            symbol?: string;
            name?: string;
            decimals?: number;
            liquidity?: number;
            logoURI?: string;
            volume24hUSD?: number;
            rank?: number;
            price?: number;
        }>;
        total?: number;
    };
}

// Token List V2 Types
export interface TokenListV2Params {
    offset?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
}

// this endpoint is for enterprise only and the response is not documented
export interface TokenListV2Response {
    success: boolean;
    data: any;
}

export interface TokenMetadataMultiParams {
    list_addresses: string;
}

export interface TokenMetadataMultiResponse {
    success: boolean;
    data: {
        [address: string]: {
            address?: string;
            symbol?: string;
            name?: string;
            decimals?: number;
            extensions?: {
                coingecko_id?: string;
                website?: string;
                twitter?: string;
                discord?: string;
                medium?: string;
            };
            logo_uri?: string;
        };
    };
}

export interface TokenTradeDataMultiParams {
    list_addresses: string;
}

export interface TokenTradeDataMultiResponse {
    success: boolean;
    data: {
        [address: string]: TokenTradeData;
    };
}

// Token Metadata Single Types
export interface TokenMetadataSingleParams {
    address: string;
}

export interface TokenMetadataSingleResponse {
    success: boolean;
    data: {
        address?: string;
        symbol?: string;
        name?: string;
        decimals?: number;
        extensions?: {
            coingecko_id?: string;
            website?: string;
            twitter?: string;
            discord?: string;
            medium?: string;
        };
        logo_uri?: string;
    };
}

// Token Market Data Types
export interface TokenMarketDataParams {
    address: string;
}

export interface TokenMarketDataResponse {
    success: boolean;
    data: {
        address?: string;
        liquidity?: number;
        price?: number;
        supply?: number;
        marketcap?: number;
        circulating_supply?: number;
        circulating_marketcap?: number;
    };
}

// Token Trade Data Single Types
export interface TokenTradeDataSingleParams {
    address: string;
}

export interface TokenTradeDataSingleResponse {
    success: boolean;
    data: TokenTradeData;
}

// Token Market Stats Types
export interface TokenMarketStatsResponse {
    success: boolean;
    data: {
        address: string;
        liquidity: number;
        price: number;
        supply: number;
        marketcap: number;
        circulating_supply: number;
        circulating_marketcap: number;
    };
}

// Token Holders Types
export interface TokenHoldersParams {
    address: string;
    offset?: number;
    limit?: number;
}

export interface TokenHoldersResponse {
    success: boolean;
    data: {
        items: Array<{
            amount?: string;
            decimals?: number;
            mint?: string;
            owner?: string;
            token_account?: string;
            ui_amount?: number;
        }>;
    };
}

// Token Mint Burn Types
export interface MintBurnParams {
    address: string;
    sort_by: "block_time";
    sort_type: "asc" | "desc";
    type: "mint" | "burn" | "all";
    after_time?: number;
    before_time?: number;
    offset?: number;
    limit?: number;
}

export interface MintBurnResponse {
    success: boolean;
    data: {
        items: Array<{
            amount?: string;
            block_human_time?: string;
            block_time?: number;
            common_type?: "mint" | "burn";
            decimals?: number;
            mint?: string;
            program_id?: string;
            slot?: number;
            tx_hash?: string;
            ui_amount?: number;
            ui_amount_string?: string;
        }>;
    };
}

// New Listing Types
export interface NewListingParams {
    time_to: number;
    meme_platform_enabled: boolean;
    limit?: number;
}

export interface NewListingResponse {
    success: boolean;
    data: {
        items: Array<{
            address: string;
            symbol: string;
            name: string;
            decimals: number;
            source: string;
            liquidityAddedAt: string;
            logoURI: string | null;
            liquidity: number;
        }>;
    };
}

// Top Traders Types
export interface TopTradersParams {
    address: string;
    time_frame?: TimeInterval;
    sort_type?: "asc" | "desc";
    sort_by?: "volume" | "trade";
    offset?: number;
    limit?: number;
}

export interface TopTradersResponse {
    success: boolean;
    data: {
        items: Array<{
            trader: string;
            volume24h: number;
            trades24h: number;
            profit24h: number;
        }>;
        total: number;
    };
}

// All Markets Types
export interface AllMarketsParams {
    address: string;
    time_frame: TimeInterval;
    sort_type: "asc" | "desc";
    sort_by: "volume24h" | "liquidity";
    offset?: number;
    limit?: number;
}

export interface AllMarketsResponse {
    success: boolean;
    data: {
        items: Array<{
            address: string;
            base: {
                address: string;
                decimals: number;
                symbol: string;
                icon?: string;
            };
            quote: {
                address: string;
                decimals: number;
                symbol: string;
                icon?: string;
            };
            createdAt: string;
            liquidity: number;
            name: string;
            price: number | null;
            source: string;
            trade24h: number;
            trade24hChangePercent: number;
            uniqueWallet24h: number;
            uniqueWallet24hChangePercent: number;
            volume24h: number;
        }>;
        total: number;
    };
}

// Token Volume By Owner Types
export interface TokenVolumeByOwnerResponse {
    success: boolean;
    data: {
        items: Array<{
            tokenAddress: string;
            owner: string;
            tags: string[];
            type: string;
            volume: number;
            trade: number;
            tradeBuy: number;
            tradeSell: number;
            volumeBuy: number;
            volumeSell: number;
        }>;
    };
}
