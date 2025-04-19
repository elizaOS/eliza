# @elizaos/plugin-cosmos

## Purpose

Provides actions and utilities for interacting with Cosmos-compatible blockchains.

## Configuration

### Default Setup

- Required environment variables:
  ```
  COSMOS_RECOVERY_PHRASE=your recovery phrase words
  COSMOS_AVAILABLE_CHAINS=chain1,chain2,chain3
  ```
- Chain names must match identifiers from the chain-registry library

### Using the Cosmos Helper Character

- Pre-configured character optimized for Cosmos operations
- Handles repeated prompts effectively
- Requests confirmation before executing actions
- Usage: `--characters='../characters/cosmosHelper.character.json'`

### Custom Chain Configuration

- Custom chain data can be passed to `createCosmosPlugin`
- Must fulfill interfaces from `chain-registry`

## Actions

### Token Transfer

- Transfers tokens between addresses on Cosmos blockchains
- Requires confirmation for secure execution

### Token IBC Transfer

- Transfers tokens between different Cosmos-compatible blockchains
- Requires confirmation

### Token IBC Swap

- Swaps tokens between chains using Skip API
- Requires chains to be added to env file
- Handles special cases like multiple tokens with same symbol

## Development

- Environment setup requires configuration variables
- Run with `bun run dev`
- Testing: `bun test`

## Links

- [Skip API Documentation](https://docs.skip.build/)
