# Steer Finance Liquidity Protocol Integration

This module provides comprehensive integration with the Steer Finance liquidity protocol, including both SDK-based and GraphQL-based data retrieval.

## Features

- **Multi-chain Support**: Ethereum, Polygon, Arbitrum, Optimism, and Base
- **SDK Integration**: Uses official Steer Protocol SDK for core functionality
- **GraphQL Enrichment**: Pulls additional vault data from Steer Protocol subgraph
- **Vault Discovery**: Find vaults containing specific tokens
- **Liquidity Analytics**: TVL, volume, APY, and fee analysis
- **Single-Asset Deposits**: Support for single-token deposits with automatic balancing

## GraphQL Integration

The service now automatically enriches vault data with detailed information from the Steer Protocol subgraph:

### Endpoint
```
https://api.subgraph.ormilabs.com/api/public/803c8c8c-be12-4188-8523-b9853e23051d/subgraphs/steer-protocol-base/prod/gn
```

### Data Retrieved
When a vault is identified, the service automatically fetches:

- **Basic Vault Info**: Name, token pairs, pool address
- **Financial Metrics**: Weekly fee APR, token balances, LP token supply
- **Strategy Details**: Strategy token info, beacon name, creator details
- **Fee Information**: Fee tier, accumulated fees for both tokens
- **Metadata**: IPFS payload, deployer address

### Example GraphQL Query
```graphql
query GetVault($vaultId: ID!) {
    vault(id: $vaultId) {
        id
        name
        token0
        token1
        pool
        weeklyFeeAPR
        token0Symbol
        token0Decimals
        token1Symbol
        token1Decimals
        token0Balance
        token1Balance
        totalLPTokensIssued
        feeTier
        fees0
        fees1
        strategyToken {
            id
            name
            creator {
                id
            }
            admin
            executionBundle
        }
        beaconName
        payloadIpfs
        deployer
    }
}
```

## Usage

### Basic Token Search
```typescript
// Search for vaults containing a specific token
const tokenStats = await steerLiquidityService.getTokenLiquidityStats('0xA0b86a33E6441b8c4C8C1C1B8c4C8C1C1B8c4C8C1B8');
```

### Direct Vault Lookup
```typescript
// Get detailed vault information (GraphQL + SDK)
const vaultDetails = await steerLiquidityService.getVaultDetails('0x88dbbb53aa3253afd45b4ff1b40a84e36608b212', 8453);
```

### GraphQL Testing
```typescript
// Test GraphQL connection
const graphqlStatus = await steerLiquidityService.testGraphQLConnection();

// Test specific vault query
const vaultTest = await steerLiquidityService.testGraphQLVaultQuery('0x88dbbb53aa3253afd45b4ff1b40a84e36608b212');
```

## Data Flow

1. **SDK Data**: Basic vault information retrieved via Steer Protocol SDK
2. **GraphQL Enrichment**: Additional data fetched from subgraph
3. **Data Merging**: SDK and GraphQL data combined into enriched vault objects
4. **Display**: Provider formats and displays all available information

## Testing

Run the GraphQL test script to verify connectivity:

```bash
npx ts-node test-graphql.ts
```

This will test:
- Basic connection to the subgraph
- Vault-specific queries
- List vaults functionality

## Error Handling

The service gracefully handles GraphQL failures:
- Falls back to SDK-only data if GraphQL is unavailable
- Logs errors for debugging
- Continues operation with partial data

## Performance

- **Caching**: 5-minute TTL for frequently accessed data
- **Parallel Processing**: Multiple chains processed concurrently
- **Selective Enrichment**: GraphQL data only fetched when needed

## Supported Chains

- **Ethereum Mainnet** (Chain ID: 1)
- **Polygon** (Chain ID: 137)
- **Arbitrum One** (Chain ID: 42161)
- **Optimism** (Chain ID: 10)
- **Base** (Chain ID: 8453)

## Dependencies

- `@steerprotocol/sdk`: Official Steer Protocol SDK
- `viem`: Ethereum client library
- `@elizaos/core`: Core framework

## Configuration

The service automatically configures:
- Multi-chain Viem clients
- Steer Protocol SDK instances
- GraphQL endpoint connections
- Caching strategies

## Monitoring

The service provides comprehensive logging:
- Connection status for each chain
- GraphQL query success/failure
- Data enrichment progress
- Error details for debugging
