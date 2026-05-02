import type {
    BaseQuoteParams,
    DefiHistoryPriceParams,
    DefiMultiPriceParams,
    DefiPriceParams,
    HistoricalPriceUnixParams,
    MultiPriceVolumeParams,
    OHLCVParams,
    PriceVolumeParams,
} from "./defi";
import type {
    OHLCVPairParams,
    PairOverviewMultiParams,
    PairOverviewSingleParams,
    PairTradesParams,
} from "./pair";
import type { TokenMarketSearchParams } from "./search";
import type {
    AllMarketsParams,
    MintBurnParams,
    NewListingParams,
    TokenCreationInfoParams,
    TokenHoldersParams,
    TokenListV2Params,
    TokenMarketDataParams,
    TokenMetadataMultiParams,
    TokenMetadataSingleParams,
    TokenOverviewParams,
    TokenSecurityParams,
    TokenTradeDataMultiParams,
    TokenTradeDataSingleParams,
    TokenTradesParams,
    TopTradersParams,
} from "./token";
import type { GainersLosersParams, TraderTransactionsSeekParams } from "./trader";
import type {
    WalletPortfolioMultichainParams,
    WalletPortfolioParams,
    WalletSimulationParams,
    WalletTokenBalanceParams,
    WalletTransactionHistoryMultichainParams,
    WalletTransactionHistoryParams,
} from "./wallet";

export type BirdeyeApiParams =
    | DefiPriceParams
    | DefiMultiPriceParams
    | DefiHistoryPriceParams
    | HistoricalPriceUnixParams
    | OHLCVParams
    | PriceVolumeParams
    | MultiPriceVolumeParams
    | PairTradesParams
    | OHLCVPairParams
    | PairOverviewMultiParams
    | PairOverviewSingleParams
    | TokenMarketSearchParams
    | TokenTradesParams
    | TokenSecurityParams
    | TokenOverviewParams
    | TokenCreationInfoParams
    | TokenListV2Params
    | TokenMetadataMultiParams
    | TokenTradeDataMultiParams
    | GainersLosersParams
    | TraderTransactionsSeekParams
    | WalletPortfolioParams
    | WalletTokenBalanceParams
    | WalletTransactionHistoryParams
    | BaseQuoteParams
    | TokenHoldersParams
    | MintBurnParams
    | TopTradersParams
    | AllMarketsParams
    | NewListingParams
    | TokenMetadataSingleParams
    | TokenMarketDataParams
    | TokenTradeDataSingleParams
    | WalletPortfolioMultichainParams
    | WalletTransactionHistoryMultichainParams
    | WalletSimulationParams
    | Record<string, never>;

export interface BirdeyeApiResponseWrapper<T> {
    data: T;
    success: boolean;
}

export type BirdeyeApiResponse = BirdeyeApiResponseWrapper<any>;

export type TimeInterval =
    | "1m"
    | "3m"
    | "5m"
    | "15m"
    | "30m"
    | "1H"
    | "2H"
    | "4H"
    | "6H"
    | "8H"
    | "12H"
    | "1D"
    | "3D"
    | "1W"
    | "1M"
    | "30m"
    | "1h"
    | "2h"
    | "4h"
    | "6h"
    | "8h"
    | "12h"
    | "24h";

export interface TokenTradeData {
    address: string;
    holder: number;
    market: number;
    last_trade_unix_time: number;
    last_trade_human_time: string;
    price: number;
    history_30m_price: number;
    price_change_30m_percent: number;
    history_1h_price: number;
    price_change_1h_percent: number;
    history_2h_price: number;
    price_change_2h_percent: number;
    history_4h_price: number;
    price_change_4h_percent: number;
    history_6h_price: number;
    price_change_6h_percent: number;
    history_8h_price: number;
    price_change_8h_percent: number;
    history_12h_price: number;
    price_change_12h_percent: number;
    history_24h_price: number;
    price_change_24h_percent: number;
    unique_wallet_30m: number;
    unique_wallet_history_30m: number;
    unique_wallet_30m_change_percent: number | null;
    unique_wallet_1h: number;
    unique_wallet_history_1h: number;
    unique_wallet_1h_change_percent: number | null;
    unique_wallet_2h: number;
    unique_wallet_history_2h: number;
    unique_wallet_2h_change_percent: number | null;
    unique_wallet_4h: number;
    unique_wallet_history_4h: number;
    unique_wallet_4h_change_percent: number | null;
    unique_wallet_8h: number;
    unique_wallet_history_8h: number;
    unique_wallet_8h_change_percent: number | null;
    unique_wallet_24h: number;
    unique_wallet_history_24h: number;
    unique_wallet_24h_change_percent: number | null;
    trade_30m: number;
    trade_history_30m: number;
    trade_30m_change_percent: number;
    sell_30m: number;
    sell_history_30m: number;
    sell_30m_change_percent: number;
    buy_30m: number;
    buy_history_30m: number;
    buy_30m_change_percent: number;
    volume_30m: number;
    volume_30m_usd: number;
    volume_history_30m: number;
    volume_history_30m_usd: number;
    volume_30m_change_percent: number;
    volume_buy_30m: number;
    volume_buy_30m_usd: number;
    volume_buy_history_30m: number;
    volume_buy_history_30m_usd: number;
    volume_buy_30m_change_percent: number;
    volume_sell_30m: number;
    volume_sell_30m_usd: number;
    volume_sell_history_30m: number;
    volume_sell_history_30m_usd: number;
    volume_sell_30m_change_percent: number;
    trade_1h: number;
    trade_history_1h: number;
    trade_1h_change_percent: number;
    sell_1h: number;
    sell_history_1h: number;
    sell_1h_change_percent: number;
    buy_1h: number;
    buy_history_1h: number;
    buy_1h_change_percent: number;
    volume_1h: number;
    volume_1h_usd: number;
    volume_history_1h: number;
    volume_history_1h_usd: number;
    volume_1h_change_percent: number;
    volume_buy_1h: number;
    volume_buy_1h_usd: number;
    volume_buy_history_1h: number;
    volume_buy_history_1h_usd: number;
    volume_buy_1h_change_percent: number;
    volume_sell_1h: number;
    volume_sell_1h_usd: number;
    volume_sell_history_1h: number;
    volume_sell_history_1h_usd: number;
    volume_sell_1h_change_percent: number;
    trade_2h: number;
    trade_history_2h: number;
    trade_2h_change_percent: number;
    sell_2h: number;
    sell_history_2h: number;
    sell_2h_change_percent: number;
    buy_2h: number;
    buy_history_2h: number;
    buy_2h_change_percent: number;
    volume_2h: number;
    volume_2h_usd: number;
    volume_history_2h: number;
    volume_history_2h_usd: number;
    volume_2h_change_percent: number;
    volume_buy_2h: number;
    volume_buy_2h_usd: number;
    volume_buy_history_2h: number;
    volume_buy_history_2h_usd: number;
    volume_buy_2h_change_percent: number;
    volume_sell_2h: number;
    volume_sell_2h_usd: number;
    volume_sell_history_2h: number;
    volume_sell_history_2h_usd: number;
    volume_sell_2h_change_percent: number;
    trade_4h: number;
    trade_history_4h: number;
    trade_4h_change_percent: number;
    sell_4h: number;
    sell_history_4h: number;
    sell_4h_change_percent: number;
    buy_4h: number;
    buy_history_4h: number;
    buy_4h_change_percent: number;
    volume_4h: number;
    volume_4h_usd: number;
    volume_history_4h: number;
    volume_history_4h_usd: number;
    volume_4h_change_percent: number;
    volume_buy_4h: number;
    volume_buy_4h_usd: number;
    volume_buy_history_4h: number;
    volume_buy_history_4h_usd: number;
    volume_buy_4h_change_percent: number;
    volume_sell_4h: number;
    volume_sell_4h_usd: number;
    volume_sell_history_4h: number;
    volume_sell_history_4h_usd: number;
    volume_sell_4h_change_percent: number;
    trade_8h: number;
    trade_history_8h: number;
    trade_8h_change_percent: number;
    sell_8h: number;
    sell_history_8h: number;
    sell_8h_change_percent: number;
    buy_8h: number;
    buy_history_8h: number;
    buy_8h_change_percent: number;
    volume_8h: number;
    volume_8h_usd: number;
    volume_history_8h: number;
    volume_history_8h_usd: number;
    volume_8h_change_percent: number;
    volume_buy_8h: number;
    volume_buy_8h_usd: number;
    volume_buy_history_8h: number;
    volume_buy_history_8h_usd: number;
    volume_buy_8h_change_percent: number;
    volume_sell_8h: number;
    volume_sell_8h_usd: number;
    volume_sell_history_8h: number;
    volume_sell_history_8h_usd: number;
    volume_sell_8h_change_percent: number;
    trade_24h: number;
    trade_history_24h: number;
    trade_24h_change_percent: number;
    sell_24h: number;
    sell_history_24h: number;
    sell_24h_change_percent: number;
    buy_24h: number;
    buy_history_24h: number;
    buy_24h_change_percent: number;
    volume_24h: number;
    volume_24h_usd: number;
    volume_history_24h: number;
    volume_history_24h_usd: number;
    volume_24h_change_percent: number;
    volume_buy_24h: number;
    volume_buy_24h_usd: number;
    volume_buy_history_24h: number;
    volume_buy_history_24h_usd: number;
    volume_buy_24h_change_percent: number;
    volume_sell_24h: number;
    volume_sell_24h_usd: number;
    volume_sell_history_24h: number;
    volume_sell_history_24h_usd: number;
    volume_sell_24h_change_percent: number;
}
