import { filteredTokensQuery } from "../graphql/tokensQuery";
import { GraphqlProvider } from "../providers/graphql";

type GetTokenType = {
    provider: GraphqlProvider;
    ticker: string;
};

type FilteredTokensResponse = {
    filteredTokens: {
        edges: {
            node: {
                type: string;
                name: string;
                identifier: string;
                ticker: string;
                liquidityUSD: number;
            };
        }[];
    };
};

export const getToken = async ({ provider, ticker }: GetTokenType) => {
    const { filteredTokens } = await provider.query<FilteredTokensResponse>(
        filteredTokensQuery,
        {
            filters: {
                searchToken: ticker,
                enabledSwaps: true,
            },
        },
    );

    const token = filteredTokens.edges.find(
        (token) => token?.node?.ticker?.toLowerCase() === ticker.toLowerCase(),
    );

    if (!token) {
        throw new Error("Invalid token");
    }

    return token.node;
};
