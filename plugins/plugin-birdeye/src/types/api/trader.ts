// Trader Gainers Losers Types
export interface GainersLosersParams {
    type: "yesterday" | "today" | "1W";
    sort_by: "PnL";
    sort_type: "asc" | "desc";
    offset?: number;
    limit?: number;
}

export interface GainersLosersResponse {
    success: boolean;
    data: {
        items: Array<{
            network?: string;
            address?: string;
            pnl?: number;
            trade_count?: number;
            volume?: number;
        }>;
    };
}

// Trader Transactions Seek Types
export interface TraderTransactionsSeekParams {
    address: string;
    offset?: number;
    limit?: number;
    tx_type?: "swap" | "add" | "remove" | "all";
    before_time?: number;
    after_time?: number;
}

export interface TraderTransactionsSeekResponse {
    success: boolean;
    data: {
        items: Array<{
            quote?: {
                symbol?: string;
                decimals?: number;
                address?: string;
                amount?: number;
                type?: string;
                type_swap?: "from" | "to";
                ui_amount?: number;
                price?: number | null;
                nearest_price?: number;
                change_amount?: number;
                ui_change_amount?: number;
            };
            base?: {
                symbol?: string;
                decimals?: number;
                address?: string;
                amount?: number;
                type?: string;
                type_swap?: "from" | "to";
                fee_info?: any | null;
                ui_amount?: number;
                price?: number | null;
                nearest_price?: number;
                change_amount?: number;
                ui_change_amount?: number;
            };
            base_price?: number | null;
            quote_price?: number | null;
            tx_hash?: string;
            source?: string;
            block_unix_time?: number;
            tx_type?: string;
            address?: string;
            owner?: string;
        }>;
        hasNext?: boolean;
    };
}
