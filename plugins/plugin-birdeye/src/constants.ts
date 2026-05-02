export const DEFAULT_MAX_RETRIES = 3;

export const BIRDEYE_SERVICE_NAME = "birdeye"

export const DEFAULT_SUPPORTED_SYMBOLS = {
    SOL: "So11111111111111111111111111111111111111112",
    BTC: "qfnqNqs3nCAHjnyCgLRDbBtq4p2MtHZxw8YjSyYhPoL",
    ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    Example: "2weMjPLLybRMMva1fM3U31goWWrCpF59CHWNhnCJ9Vyh",
};

export const API_BASE_URL = "https://public-api.birdeye.so";

export const RETRY_DELAY_MS = 2_000;

export const BIRDEYE_ENDPOINTS = {
    defi: {
        networks: "/defi/networks", // https://docs.birdeye.so/reference/get_defi-networks
        price: "/defi/price", // https://docs.birdeye.so/reference/get_defi-price
        price_multi: "/defi/multi_price", // https://docs.birdeye.so/reference/get_defi-multi-price
        price_multi_POST: "/defi/multi_price", // https://docs.birdeye.so/reference/post_defi-multi-price
        history_price: "/defi/history_price", // https://docs.birdeye.so/reference/get_defi-history-price
        historical_price_unix: "/defi/historical_price_unix", // https://docs.birdeye.so/reference/get_defi-historical-price-unix
        trades_token: "/defi/txs/token", // https://docs.birdeye.so/reference/get_defi-txs-token
        trades_pair: "/defi/txs/pair", // https://docs.birdeye.so/reference/get_defi-txs-pair
        trades_token_seek: "/defi/txs/token/seek_by_time", // https://docs.birdeye.so/reference/get_defi-txs-token-seek-by-time
        trades_pair_seek: "/defi/txs/pair/seek_by_time", // https://docs.birdeye.so/reference/get_defi-txs-pair-seek-by-time
        ohlcv: "/defi/ohlcv", // https://docs.birdeye.so/reference/get_defi-ohlcv
        ohlcv_pair: "/defi/ohlcv/pair", // https://docs.birdeye.so/reference/get_defi-ohlcv-pair
        ohlcv_base_quote: "/defi/ohlcv/base_quote", // https://docs.birdeye.so/reference/get_defi-ohlcv-base-quote
        price_volume: "/defi/price_volume/single", // https://docs.birdeye.so/reference/get_defi-price-volume-single
        price_volume_multi: "/defi/price_volume/multi", // https://docs.birdeye.so/reference/get_defi-price-volume-multi
        price_volume_multi_POST: "/defi/price_volume/multi", // https://docs.birdeye.so/reference/post_defi-price-volume-multi
    },
    token: {
        list_all: "/defi/tokenlist", // https://docs.birdeye.so/reference/get_defi-tokenlist
        security: "/defi/token_security", // https://docs.birdeye.so/reference/get_defi-token-security
        overview: "/defi/token_overview", // https://docs.birdeye.so/reference/get_defi-token-overview
        creation_info: "/defi/token_creation_info", // https://docs.birdeye.so/reference/get_defi-token-creation-info
        trending: "/defi/token_trending", // https://docs.birdeye.so/reference/get_defi-token-trending
        list_all_v2_POST: "/defi/v2/tokens/all", // https://docs.birdeye.so/reference/post_defi-v2-tokens-all
        new_listing: "/defi/v2/tokens/new_listing", // https://docs.birdeye.so/reference/get_defi-v2-tokens-new-listing
        top_traders: "/defi/v2/tokens/top_traders", // https://docs.birdeye.so/reference/get_defi-v2-tokens-top-traders
        all_markets: "/defi/v2/markets", // https://docs.birdeye.so/reference/get_defi-v2-markets
        metadata_single: "/defi/v3/token/meta-data/single", // https://docs.birdeye.so/reference/get_defi-v3-token-meta-data-single
        metadata_multi: "/defi/v3/token/meta-data/multiple", // https://docs.birdeye.so/reference/get_defi-v3-token-meta-data-multiple
        market_data: "/defi/v3/token/market-data", // https://docs.birdeye.so/reference/get_defi-v3-token-market-data
        trade_data_single: "/defi/v3/token/trade-data/single", // https://docs.birdeye.so/reference/get_defi-v3-token-trade-data-single
        trade_data_multi: "/defi/v3/token/trade-data/multiple", // https://docs.birdeye.so/reference/get_defi-v3-token-trade-data-multiple
        holders: "/defi/v3/token/holder", // https://docs.birdeye.so/reference/get_defi-v3-token-holder
        mint_burn: "/defi/v3/token/mint-burn-txs", // https://docs.birdeye.so/reference/get_defi-v3-token-mint-burn-txs
    },
    wallet: {
        networks: "/v1/wallet/list_supported_chain", // https://docs.birdeye.so/reference/get_v1-wallet-list-supported-chain
        portfolio: "/v1/wallet/token_list", // https://docs.birdeye.so/reference/get_v1-wallet-token-list
        portfolio_multichain: "/v1/wallet/multichain_token_list", // https://docs.birdeye.so/reference/get_v1-wallet-multichain-token-list
        token_balance: "/v1/wallet/token_balance", // https://docs.birdeye.so/reference/get_v1-wallet-token-balance
        transaction_history: "/v1/wallet/tx_list", // https://docs.birdeye.so/reference/get_v1-wallet-tx-list
        transaction_history_multichain: "/v1/wallet/multichain_tx_list", // https://docs.birdeye.so/reference/get_v1-wallet-multichain-tx-list
        transaction_simulation_POST: "/v1/wallet/simulate", // https://docs.birdeye.so/reference/post_v1-wallet-simulate
    },
    trader: {
        gainers_losers: "/trader/gainers-losers", // https://docs.birdeye.so/reference/get_trader-gainers-losers
        trades_seek: "/trader/txs/seek_by_time", // https://docs.birdeye.so/reference/get_trader-txs-seek-by-time
    },
    pair: {
        overview_multi: "/defi/v3/pair/overview/multiple", // https://docs.birdeye.so/reference/get_defi-v3-pair-overview-multiple
        overview_single: "/defi/v3/pair/overview/single", // https://docs.birdeye.so/reference/get_defi-v3-pair-overview-single
    },
    search: {
        token_market: "/defi/v3/search", // https://docs.birdeye.so/reference/get_defi-v3-search
    },
};
