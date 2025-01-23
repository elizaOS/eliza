export interface StargazeConfig {
    endpoint: string;
}

export interface NFTResponse {
    tokens: {
        tokens: Token[];
        pageInfo: {
            total: number;
            offset: number;
            limit: number;
        };
    };
}

export interface Token {
    id: string;
    tokenId: string;
    name: string;
    media: {
        url: string;
    };
    listPrice?: {
        amount: string;
        symbol: string;
    };
}

// Collection Types
export interface CollectionStats {
    floor: {
        amount: string;
        symbol: string;
    };
    totalVolume: {
        amount: string;
        symbol: string;
    };
    owners: number;
    listed: number;
    totalSupply: number;
}

export interface TokenSale {
    id: string;
    token: {
        tokenId: string;
        name: string;
        media: {
            url: string;
        };
    };
    price: number;
    priceUsd: number;
    date: string;
    saleDenomSymbol: string;
    saleType: string;
    buyer: {
        address: string;
    };
    seller: {
        address: string;
    };
}

export interface TokenSalesResponse {
    data: {
        tokenSales: {
            tokenSales: TokenSale[];
        };
    };
}