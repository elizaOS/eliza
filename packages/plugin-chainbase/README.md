# Chainbase Plugin for Eliza

The Chainbase Plugin for Eliza bridges the gap between on-chain data and AI agents, enabling natural language interactions with blockchain data across multiple networks. This plugin leverages Chainbase's comprehensive blockchain data infrastructure to provide real-time insights and analytics.

## Description

This plugin serves as a powerful interface between Eliza AI agents and blockchain data, allowing users to query and analyze on-chain information using natural language. It transforms complex blockchain queries into actionable insights without requiring deep technical knowledge.

## Key Features

- **Multi-chain Data Access**: Access comprehensive data across multiple blockchain networks
- **Natural Language Processing**: Convert natural language queries into blockchain data analytics and insights
- **Real-time Data**: Get up-to-date blockchain information and analytics

## Supported Networks

- Ethereum
- Polygon
- BNB Smart Chain (BSC)
- Avalanche
- Arbitrum One
- Optimism
- Base
- zkSync
- Merlin

## Usage Examples

### On-chain Data Queries

```plaintext
Query: "query onchain data: This address 0x8308964da9ed5d2e8012023d7c7ef02f9e6438c7 which tokens on Ethereum are held"
```

This query will return the token holdings for the specified Ethereum address.

```plaintext
Query: "query onchain data: List the top 10 Ethereum blocks by total gas used in the last 24 hours"
```

This query will analyze and return gas usage statistics for recent Ethereum blocks.

```plaintext
Query: "query onchain data: The address 0x8308964da9ed5d2e8012023d7c7ef02f9e6438c7 last 10 Ethereum token transfer"
```

This query will fetch the most recent 10 token transfer events for the specified Ethereum address, including both incoming and outgoing transfers.

## Components

- **Actions**: Pre-configured blockchain data retrieval and analysis actions
- **Providers**: Data providers for different blockchain networks
- **Evaluators**: Analysis tools for blockchain data interpretation
- **Services**: Specialized services for data processing and transformation

## Getting Started

To use this plugin, you'll need a Chainbase API key:

1. Visit [Chainbase Platform](https://console.chainbase.com) to create an account
2. Once logged in, you can obtain a free API key from your dashboard
3. Set your API key as the `CHAINBASE_API_KEY` environment variable

For development and testing purposes, you can use the API key "demo" to test the basic functionality.

For more detailed information about the available APIs and endpoints, please refer to the [Chainbase API Documentation](https://docs.chainbase.com/api-reference/overview).
