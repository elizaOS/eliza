import { gql } from "graphql-request";

export const filteredTokensQuery = gql`
    query filteredTokensQuery($filters: TokensFilter) {
        filteredTokens(filters: $filters) {
            edges {
                node {
                    type
                    name
                    identifier
                    ticker
                    liquidityUSD
                    assets {
                        description
                    }
                }
            }
        }
    }
`;
