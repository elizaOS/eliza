// Network configuration object for different environments (mainnet, devnet, testnet)
export const MVX_NETWORK_CONFIG = {
    mainnet: {
        chainID: "1", // Mainnet chain ID
        apiURL: "https://api.multiversx.com", // Mainnet API URL
        explorerURL: "https://explorer.multiversx.com",
        graphURL: "https://internal-graph.xexchange.com/graphql",
    },
    devnet: {
        chainID: "D", // Devnet chain ID
        apiURL: "https://devnet-api.multiversx.com", // Devnet API URL,
        explorerURL: "https://devnet-explorer.multiversx.com",
        graphURL: "https://devnet-graph.xexchange.com/graphql",
    },
    testnet: {
        chainID: "T", // Testnet chain ID
        apiURL: "https://testnet-api.multiversx.com", // Testnet API URL
        explorerURL: "https://testnet-explorer.multiversx.com",
        graphURL: "https://testnet-graph.xexchange.com/graphql",
    },
};
