# Pyth Data Plugin for ElizaOS

A powerful plugin for interacting with Pyth Network price feeds and data streams. This plugin provides real-time access to cryptocurrency, forex, and other asset price data through a natural language interface.

## Features

- Real-time price feed streaming
- Latest price updates retrieval
- Publisher caps information
- Comprehensive price feed listings
- Natural language processing for price feed queries

## Available Actions

### 1. GET_PRICE_UPDATES_STREAM
Stream real-time price updates for specific assets.

**Example Prompts:**
```
Stream price updates for 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
Stream BTC/USD price updates
```

### 2. GET_LATEST_PRICE_UPDATES
Retrieve the most recent price updates for specific assets.

**Example Prompts:**
```
Latest price updates for 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
```

### 3. GET_LATEST_PUBLISHER_CAPS
Fetch information about publisher capabilities and limits.

**Example Prompts:**
```
Get me all the published caps
Show publisher capabilities
List all publisher caps
```

### 4. GET_PRICE_FEEDS
Retrieve available price feeds and their metadata.

**Example Prompts:**
```
Get all available price feeds from Pyth Network
List all crypto price feeds
Show me available forex feeds
```

## Configuration

Create a `.env` file in your project root with the following variables:

### Network Configuration
```env
# Network Environment (mainnet or testnet)
PYTH_NETWORK_ENV=mainnet

# Mainnet Configuration
PYTH_MAINNET_HERMES_URL=https://hermes.pyth.network
PYTH_MAINNET_WSS_URL=wss://hermes.pyth.network/ws
PYTH_MAINNET_PYTHNET_URL=https://pythnet.rpcpool.com
PYTH_MAINNET_CONTRACT_REGISTRY=https://pyth.network/developers/price-feed-ids
PYTH_MAINNET_PROGRAM_KEY=FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH

# Testnet Configuration
PYTH_TESTNET_HERMES_URL=https://hermes.pyth.network
PYTH_TESTNET_WSS_URL=wss://hermes.pyth.network/ws
PYTH_TESTNET_PYTHNET_URL=https://pythnet.rpcpool.com
PYTH_TESTNET_CONTRACT_REGISTRY=https://pyth.network/developers/price-feed-ids#testnet
PYTH_TESTNET_PROGRAM_KEY=FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH
```

### Connection Settings
```env
PYTH_MAX_RETRIES=3
PYTH_RETRY_DELAY=1000
PYTH_TIMEOUT=5000
PYTH_GRANULAR_LOG=true
PYTH_LOG_LEVEL=info
```

### Runtime Settings
```env
# General runtime configuration
RUNTIME_CHECK_MODE=false

# Streaming Configuration
PYTH_ENABLE_PRICE_STREAMING=true    # Enable/disable price streaming functionality
PYTH_MAX_PRICE_STREAMS=2            # Number of price updates to collect before closing stream
                                    # Can be set to higher values (e.g., 10000) for production use
```

The streaming configuration controls how the price feed streaming works:
- `PYTH_ENABLE_PRICE_STREAMING`: Toggle to enable/disable the streaming functionality. Set to `true` to allow real-time price updates.
- `PYTH_MAX_PRICE_STREAMS`: Controls how many price updates to collect before automatically closing the stream. While set to 2 for testing, this can be increased to much higher values (e.g., 10000) for production use cases where continuous streaming is needed.

### Test Price Feed IDs
```env
PYTH_TEST_ID01=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
PYTH_TEST_ID02=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
```
## Features

- **Automatic Price ID Detection**: Supports both hex IDs and common symbols (BTC/USD, ETH/USD, etc.)
- **Flexible Data Formats**: Supports both hex and base64 encoding
- **Granular Logging**: Detailed logging for debugging and monitoring
- **Error Handling**: Comprehensive error handling with detailed feedback
- **Streaming Control**: Configurable stream limits and timeouts

## Dependencies

This plugin uses the official `@pythnetwork/hermes-client` for reliable data access and streaming capabilities.

## Error Handling

The plugin includes comprehensive error handling for:
- Invalid price feed IDs
- Network connection issues
- Configuration errors
- Validation failures
- Stream management

## Logging

Enable granular logging by setting `PYTH_GRANULAR_LOG=true` for detailed operation insights.

## Contributing

Contributions are welcome! Please ensure you:
1. Follow the code style
2. Add tests for new features
3. Update documentation as needed
4. Maintain type safety
