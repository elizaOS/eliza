# ElizaOS Story Protocol Plugin

## Purpose

A plugin for ElizaOS that enables interaction with Story Protocol - a comprehensive IP management system on the blockchain that allows creators to register, license, and manage their intellectual property assets.

## Key Features

- IP Registration: Register creative works as IP assets on Story Protocol
- License Management: Attach license terms to IP assets with customizable commercial terms
- IP Licensing: Mint license tokens for IP assets
- Asset Information: Fetch details about IP assets and available licenses
- Blockchain Integration: Built-in wallet provider for Odyssey testnet

## Installation

Install via npm:

```bash
bun install @elizaos-plugins/plugin-story
```

Or using bun:

```bash
bun add @elizaos-plugins/plugin-story
```

## Configuration

Add to ElizaOS agent configuration:

```javascript
// agent.config.js
export default {
  // Other ElizaOS configuration
  plugins: ['story'],
  settings: {
    STORY_PRIVATE_KEY: '0x...', // Your Story Protocol private key
    PINATA_JWT: '...', // Your Pinata JWT token
  },
};
```

## Integration

Integrates with Story Protocol on the Odyssey testnet, providing on-chain IP registration, programmable licensing with configurable commercial terms, creator attribution, revenue sharing, and IP relationship tracking.

## Example Usage

Register IP assets:

```
User: I'd like to register a short story I wrote called "The Digital Forest"
Agent: Great! What's the description for your IP?
User: It's a sci-fi story about a forest that exists in cyberspace
Agent: I'll register "The Digital Forest" as an IP asset on Story Protocol.
*Agent registers IP and provides transaction details*
```

## Links

- [Story Protocol Documentation](https://docs.storyprotocol.xyz)
- [Odyssey Testnet Explorer](https://odyssey.storyscan.xyz)
- [Pinata IPFS](https://www.pinata.cloud/)
