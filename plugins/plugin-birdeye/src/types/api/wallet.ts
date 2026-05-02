// Wallet Portfolio Types
export interface WalletPortfolioParams {
    wallet: string;
}

export interface WalletPortfolioResponse {
    success: boolean;
    data: {
        wallet?: string;
        totalUsd?: number;
        items: Array<{
            address?: string;
            name?: string;
            symbol?: string;
            decimals?: number;
            balance?: string;
            uiAmount?: number;
            chainId?: string;
            logoURI?: string;
            priceUsd?: number;
            valueUsd?: number;
        }>;
    };
}

// Wallet Token Balance Types
export interface WalletTokenBalanceParams {
    wallet: string;
    token_address: string;
}

export interface WalletTokenBalanceResponse {
    success: boolean;
    data: {
        address?: string;
        name?: string;
        symbol?: string;
        decimals?: number;
        balance?: number;
        uiAmount?: number;
        chainId?: string;
        priceUsd?: number;
        valueUsd?: number;
    };
}

// Wallet Transaction History Types
export interface WalletTransactionHistoryParams {
    wallet: string;
    limit?: number;
    before?: string;
}

export interface WalletTransactionHistoryResponse {
    success: boolean;
    data: {
        [chain: string]: Array<{
            txHash?: string;
            blockNumber?: number;
            blockTime?: string;
            status?: boolean;
            from?: string;
            to?: string;
            gasUsed?: number;
            gasPrice?: number;
            fee?: string;
            feeUsd?: number;
            value?: string;
            contractLabel?: {
                address?: string;
                name?: string;
                metadata?: Record<string, any>;
            };
            mainAction?: string;
            balanceChange?: Array<{
                name?: string;
                symbol?: string;
                logoURI?: string;
                address?: string;
                amount?: number;
                decimals?: number;
            }>;
        }>;
    };
}

// Wallet Networks Types
export interface WalletNetworksResponse {
    success: boolean;
    data: {
        chains?: string[];
    };
}

// Wallet Portfolio Multichain Types
export interface WalletPortfolioMultichainParams {
    wallet: string;
}

export interface WalletPortfolioMultichainResponse {
    success: boolean;
    data: {
        items: Array<{
            chain?: string;
            address?: string;
            symbol?: string;
            name?: string;
            decimals?: number;
            price?: number;
            priceChange24h?: number;
            value?: number;
            amount?: number;
        }>;
        total?: number;
        totalValue?: number;
    };
}

// Wallet Transaction History Multichain Types
export interface WalletTransactionHistoryMultichainParams {
    wallet: string;
}

export interface WalletTransactionHistoryMultichainResponse {
    success: boolean;
    data: {
        [chain: string]: Array<{
            txHash?: string;
            blockNumber?: number;
            blockTime?: string;
            status?: boolean;
            from?: string;
            to?: string;
            gasUsed?: number;
            gasPrice?: number;
            fee?: string;
            feeUsd?: number;
            value?: string;
            contractLabel?: {
                address?: string;
                name?: string;
                metadata?: Record<string, any>;
            };
            mainAction?: string;
            balanceChange?: Array<{
                name?: string;
                symbol?: string;
                logoURI?: string;
                address?: string;
                amount?: number;
                decimals?: number;
            }>;
        }>;
    };
}

// Wallet Transaction Simulation Types
export interface WalletSimulationParams {
    from?: string;
    to?: string;
    data?: string;
    value?: string;
}

export interface WalletSimulationResponse {
    success: boolean;
    data: {
        balanceChange: Array<{
            index?: number;
            before?: number;
            after?: number;
            address?: string;
            name?: string;
            symbol?: string;
            logoURI?: string;
            decimals?: number;
        }>;
        gasUsed?: number;
    };
}
