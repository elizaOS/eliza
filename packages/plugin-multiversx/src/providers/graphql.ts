import { GraphQLClient } from "graphql-request";

export class GraphqlProvider {
    private client: GraphQLClient;

    /**
     * Initialize the GraphQL client with the given URL and headers.
     * @param url - The GraphQL endpoint URL.
     * @param headers - Optional headers for the GraphQL client.
     */
    constructor(url: string, headers?: Record<string, string>) {
        this.client = new GraphQLClient(url, { headers });
    }

    /**
     * Execute a GraphQL query.
     * @param query - The GraphQL query string.
     * @param variables - Optional variables for the query.
     * @returns The result of the query.
     */
    async query<T>(query: string, variables?: Record<string, any>): Promise<T> {
        return this.client.request<T>(query, variables);
    }
}
