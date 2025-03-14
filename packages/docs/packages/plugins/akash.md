# Akash Network Plugin for Eliza

A powerful plugin for interacting with the Akash Network, enabling deployment management and cloud compute operations through Eliza.

## Table of Contents
- [Installation](#installation)
- [Configuration](#configuration)
- [Directory Structure](#directory-structure)
- [Available Actions](#available-actions)

## Installation

```bash
pnpm add @elizaos/plugin-akash
```

## Configuration

### Environment Variables
Create a `.env` file in your project root with the following configuration:

```env
# Network Configuration
AKASH_ENV=mainnet
AKASH_NET=https://raw.githubusercontent.com/ovrclk/net/master/mainnet
RPC_ENDPOINT=https://rpc.akashnet.net:443

# Transaction Settings
AKASH_GAS_PRICES=0.025uakt
AKASH_GAS_ADJUSTMENT=1.5
AKASH_KEYRING_BACKEND=os
AKASH_FROM=default
AKASH_FEES=20000uakt

# Authentication
AKASH_MNEMONIC=your_12_word_mnemonic_here

# Manifest Settings
AKASH_MANIFEST_MODE=auto                 # Options: auto, validate_only
AKASH_MANIFEST_VALIDATION_LEVEL=strict   # Options: strict, basic, none
AKASH_MANIFEST_PATH=/path/to/manifests   # Optional: Path to save generated manifests

# Deployment Settings
AKASH_DEPOSIT=5000000uakt               # Default deployment deposit
AKASH_SDL=deployment.yml                # Default SDL file name
```

**Important Notes:**
- `AKASH_MNEMONIC`: Your 12-word wallet mnemonic phrase (required)
- `AKASH_MANIFEST_MODE`: Controls manifest generation behavior
- `AKASH_MANIFEST_VALIDATION_LEVEL`: Sets SDL validation strictness
- `AKASH_DEPOSIT`: Default deposit amount for deployments

⚠️ Never commit your `.env` file with real credentials to version control!


#### SDL (Stack Definition Language)
```
src/sdl/example.sdl.yml
```
Place your SDL configuration files here. The plugin looks for SDL files in this directory by default.

#### Certificates
```
src/.certificates/
```
SSL certificates for secure provider communication are stored here.

## Available Actions

| Action               | Description                                    | Parameters                                  |
|---------------------|------------------------------------------------|---------------------------------------------|
| CREATE_DEPLOYMENT   | Create a new deployment                         | `sdl`, `sdlFile`, `deposit`                 |
| CLOSE_DEPLOYMENT    | Close an existing deployment                    | `dseq`, `owner`                            |
| GET_PROVIDER_INFO   | Get provider information                        | `provider`                                  |
| GET_DEPLOYMENT_STATUS| Check deployment status                        | `dseq`, `owner`                            |
| GET_GPU_PRICING     | Get GPU pricing comparison                      | `cpu`, `memory`, `storage`                  |
| GET_MANIFEST        | Generate deployment manifest                    | `sdl`, `sdlFile`                           |
| GET_PROVIDERS_LIST  | List available providers                        | `filter: { active, hasGPU, region }`        |


Each action returns a structured response with:
```typescript
{
    text: string;           // Human-readable response
    content: {
        success: boolean;   // Operation success status
        data?: any;        // Action-specific data
        error?: {          // Present only on failure
            code: string;
            message: string;
        };
        metadata: {        // Operation metadata
            timestamp: string;
            source: string;
            action: string;
            version: string;
            actionId: string;
        }
    }
}
```

## Error Handling

The plugin includes comprehensive error handling with specific error codes:

- `VALIDATION_SDL_FAILED`: SDL validation errors
- `WALLET_NOT_INITIALIZED`: Wallet setup issues
- `DEPLOYMENT_CREATION_FAILED`: Deployment failures
- `API_REQUEST_FAILED`: Network/API issues
- `MANIFEST_PARSING_FAILED`: Manifest generation errors
- `PROVIDER_FILTER_ERROR`: Provider filtering issues

## Development

### Running Tests
```bash
pnpm test
```

### Building
```bash
pnpm run build
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions, please open an issue in the repository or contact the maintainers.
