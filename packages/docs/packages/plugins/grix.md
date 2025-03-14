# @elizaos/plugin-grix

A plugin that enables DeFi options data fetching and price analysis through the Grix Finance API integration.

## Features

### Price Data

-   Real-time BTC/ETH price feeds
-   Options pricing across multiple protocols
-   Available liquidity information

### Options Data

-   Call and Put options data
-   Strike prices and expiry dates
-   Protocol-specific pricing
-   Position types (long/short)

## Available Actions

### getOptionPrice

Fetches options data across multiple protocols:

-   Real-time options pricing
-   Available strike prices
-   Current expiry dates
-   Protocol comparisons
-   Liquidity information
-   Position types (long/short)

### getAssetPrice

Retrieves real-time price data:

-   Current BTC price
-   Current ETH price
-   Price updates in real-time
 
## Installation

```bash
pnpm add @elizaos/plugin-grix
```

## Configuration

To use the plugin, you'll need a Grix API key. You can request one by messaging us on [Discord](https://discord.com/invite/ZgPpr9psqp) or [Telegram](https://t.me/GrixFinance).

There are two ways to configure your API key:

### 1. Environment Variables

```env
GRIX_API_KEY=your_api_key
```

### 2. Character Configuration

```json
{
	"name": "Your Character",
	"plugins": ["@elizaos/plugin-grix"],
	"settings": {
		"secrets": {
			"GRIX_API_KEY": "your_api_key_here"
		}
	}
}
```

## Quick Start

1. Visit [Grix Finance](https://app.grix.finance)
2. Request your API key through our Discord or Telegram
3. Add configuration using either method above
4. Start fetching options data!

## Community & Support

-   [Discord Community](https://discord.com/invite/ZgPpr9psqp)
-   [Telegram Group](https://t.me/GrixFinance)
-   [Documentation](https://app.grix.finance/docs)


## Development

### Building

```bash
pnpm build
```

### Running with Eliza

1. Install dependencies:

```bash
pnpm install
```

2. Configure your API key using one of the methods described in the Configuration section

3. Start Eliza with your character:

```bash
pnpm start --character="characters/your_character.character.json"
```

## License

MIT

## Disclaimer

Please ensure compliance with your local regulations regarding options trading.
