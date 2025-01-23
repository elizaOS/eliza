# @elizaos/plugin-agentkit

AgentKit plugin for Eliza that enables interaction with CDP AgentKit tools for NFT and token management.

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables:

```env
CDP_API_KEY_NAME=your_key_name
CDP_API_KEY_PRIVATE_KEY=your_private_key
CDP_AGENT_KIT_NETWORK=base-sepolia # Optional: Defaults to base-sepolia
```

3. Add the plugin to your character configuration:

```json
{
    "plugins": ["@elizaos/plugin-agentkit"],
    "settings": {
        "secrets": {
            "CDP_API_KEY_NAME": "your_key_name",
            "CDP_API_KEY_PRIVATE_KEY": "your_private_key"
        }
    }
}
```

## Available Tools

The plugin provides access to the following CDP AgentKit tools:

-   `GET_WALLET_DETAILS`: Get wallet information
-   `DEPLOY_NFT`: Deploy a new NFT collection
-   `DEPLOY_TOKEN`: Deploy a new token
-   `GET_BALANCE`: Check token or NFT balance
-   `MINT_NFT`: Mint NFTs from a collection
-   `REGISTER_BASENAME`: Register a basename for NFTs
-   `REQUEST_FAUCET_FUNDS`: Request testnet funds
-   `TRADE`: Execute trades
-   `TRANSFER`: Transfer tokens or NFTs
-   `WOW_BUY_TOKEN`: Buy WOW tokens
-   `WOW_SELL_TOKEN`: Sell WOW tokens
-   `WOW_CREATE_TOKEN`: Create new WOW tokens

## Usage Examples

1. Get wallet details:

```
Can you show me my wallet details?
```

2. Deploy an NFT collection:

```
Deploy a new NFT collection called "Music NFTs" with symbol "MUSIC"
```

3. Create a token:

```
Create a new WOW token called "Artist Token" with symbol "ART"
```

4. Check balance:

```
What's my current balance?
```

## Development

1. Build the plugin:

```bash
pnpm build
```

2. Run in development mode:

```bash
pnpm dev
```

## Dependencies

-   @elizaos/core
-   @coinbase/cdp-agentkit-core
-   @coinbase/cdp-langchain
-   @langchain/core

## Network Support

The plugin supports the following networks:

-   Base Sepolia (default)
-   Base Mainnet

Configure the network using the `CDP_AGENT_KIT_NETWORK` environment variable.

## Troubleshooting

1. If tools are not being triggered:

    - Verify CDP API key configuration
    - Check network settings
    - Ensure character configuration includes the plugin

2. Common errors:
    - "Cannot find package": Make sure dependencies are installed
    - "API key not found": Check environment variables
    - "Network error": Verify network configuration

## License

MIT
