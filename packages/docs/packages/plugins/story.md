# ElizaOS Story Protocol Plugin

A plugin for ElizaOS that enables interaction with Story Protocol - a comprehensive IP management system on the blockchain that allows creators to register, license, and manage their intellectual property assets.

## Features

- **IP Registration**: Register creative works as IP assets on Story Protocol
- **License Management**: Attach license terms to IP assets with customizable commercial terms
- **IP Licensing**: Mint license tokens for IP assets
- **Asset Information**: Fetch details about IP assets and available licenses
- **Blockchain Integration**: Built-in wallet provider for Odyssey testnet

## Prerequisites

Before using this plugin, you'll need:

1. A Story Protocol private key (for Odyssey testnet)
2. A Pinata JWT token for IPFS storage
3. ElizaOS installed and configured

## Installation

Install the plugin via npm:

```bash
npm install @elizaos-plugins/plugin-story
```

Or using pnpm:

```bash
pnpm add @elizaos-plugins/plugin-story
```

## Configuration

Add the plugin to your ElizaOS agent configuration and provide the necessary credentials:

```javascript
// agent.config.js
export default {
  // Other ElizaOS configuration
  plugins: ["story"],
  settings: {
    STORY_PRIVATE_KEY: "0x...",  // Your Story Protocol private key
    PINATA_JWT: "..."            // Your Pinata JWT token
  }
}
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `STORY_PRIVATE_KEY` | Yes | Private key for Story Protocol (Odyssey testnet) |
| `PINATA_JWT` | Yes | JWT token for Pinata IPFS storage |

## Usage

Once configured, the plugin provides the following actions:

### Register IP Assets

Register a creative work as an IP asset on Story Protocol:

```
User: I'd like to register a short story I wrote called "The Digital Forest"
Agent: Great! What's the description for your IP?
User: It's a sci-fi story about a forest that exists in cyberspace
Agent: I'll register "The Digital Forest" as an IP asset on Story Protocol.
*Agent registers IP and provides transaction details*
```

### Attach License Terms

Attach licensing terms to your IP assets:

```
User: I want to create a license for my IP asset at 0x1234...
Agent: What kind of license would you like to attach?
User: I want commercial use allowed with 10% revenue share
Agent: I'll attach those license terms to your IP asset.
*Agent attaches license terms and provides transaction details*
```

### View IP Details

Get detailed information about an IP asset:

```
User: Can you tell me about IP asset 0x1234...
Agent: Here are the details about that IP asset:
*Agent displays IP asset details*
```

### View Available Licenses

See what licenses are available for an IP asset:

```
User: What licenses are available for IP asset 0x1234...
Agent: Here are the available licenses for this IP asset:
*Agent displays available licenses*
```

### License IP Assets

Mint license tokens for IP assets:

```
User: I want to license the IP asset at 0x1234...
Agent: Which license terms would you like to use?
User: License terms ID 5
Agent: I'll mint that license for you.
*Agent mints license token and provides transaction details*
```

## Supported Actions

| Action | Description |
|---|---|
| `REGISTER_IP` | Register a new IP asset on Story Protocol |
| `ATTACH_TERMS` | Attach license terms to an existing IP asset |
| `LICENSE_IP` | Mint license tokens for an IP asset |
| `GET_IP_DETAILS` | Fetch details about an IP asset |
| `GET_AVAILABLE_LICENSES` | List available licenses for an IP asset |

## Story Protocol Integration

This plugin integrates with Story Protocol on the Odyssey testnet, which provides:

- On-chain IP registration
- Programmable licensing with configurable commercial terms
- Creator attribution and revenue sharing
- IP relationship tracking

## Technical Details

### Wallet Integration

The plugin includes a wallet provider that manages interactions with the Story Protocol blockchain. The wallet address is derived from the private key provided in the configuration.

### IPFS Storage

IP metadata is stored on IPFS using Pinata. The plugin automatically handles the upload and referencing of metadata when registering IP assets.

### License Terms

When attaching license terms, you can configure:

- Commercial use permissions
- Revenue sharing percentages
- Minting fees
- Attribution requirements

## Troubleshooting

### Common Issues

1. **Transaction Errors**: 
   - Ensure your private key has sufficient funds on the Odyssey testnet
   - Check for valid IP IDs and license term IDs

2. **IPFS Upload Failures**: 
   - Verify your Pinata JWT token is valid and has not expired
   - Ensure proper network connectivity

3. **License Attachment Failures**:
   - An IP asset must be registered before attaching license terms
   - Commercial revenue share must be between 0-100 percent

## Development

For developers wanting to extend the plugin:

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build the plugin
pnpm build

# Lint code
pnpm lint

# Format code
pnpm format:fix
```

## Links and Resources

- [Story Protocol Documentation](https://docs.storyprotocol.xyz)
- [Odyssey Testnet Explorer](https://odyssey.storyscan.xyz)
- [Pinata IPFS](https://www.pinata.cloud/)
