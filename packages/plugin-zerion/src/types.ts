export type ZerionPortfolioResponse = {
    data: {
        type: string;
        id: string;
        attributes: {
            positions_distribution_by_type: {
                wallet: number;
                deposited: number;
                borrowed: number;
                locked: number;
                staked: number;
            };
            positions_distribution_by_chain: {
                [key: string]: number;
            };
            total: {
                positions: number;
            };
            changes: {
                absolute_1d: number;
                percent_1d: number;
            };
        };
    };
}

export type ZerionPositionResponse = {
    data: Array<{
        type: string;
        id: string;
        attributes: {
            parent: any;
            protocol: any;
            name: string;
            position_type: string;
            quantity: {
                int: string;
                decimals: number;
                float: number;
                numeric: string;
            };
            value: number | null;
            price: number | null;
            changes: {
                absolute_1d: number | null;
                percent_1d: number | null;
            } | null;
            fungible_info: {
                name: string;
                symbol: string;
                icon: {
                    url: string;
                } | null;
                flags: {
                    verified: boolean;
                };
            };
            flags: {
                displayable: boolean;
                is_trash: boolean;
            };
        };
        relationships: {
            chain: {
                data: {
                    type: string;
                    id: string;
                };
            };
        };
    }>;
}

export type PortfolioData = {
    totalValue: number;
    chainDistribution: { [key: string]: number };
    positionTypes: {
        wallet: number;
        deposited: number;
        borrowed: number;
        locked: number;
        staked: number;
    };
    changes: {
        absolute_1d: number;
        percent_1d: number;
    };
}

export type PositionData = {
    positions: Array<{
        name: string;
        symbol: string;
        quantity: number;
        value: number | null;
        price: number | null;
        chain: string;
        change24h: number | null;
        verified: boolean;
    }>;
    totalValue: number;
}

export type ZerionProviderResponse = {
    success: boolean;
    data?: PortfolioData | PositionData;
    error?: string;
}