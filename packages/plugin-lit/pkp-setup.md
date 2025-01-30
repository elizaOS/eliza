# PKP Setup Guide for @plugin-lit

## Overview
This guide explains the Programmable Key Pair (PKP) setup process for @plugin-lit and the configuration file structure.

## Automatic PKP Creation

The PKP creation in @plugin-lit is automatic. The process is handled by the `litProvider` during initialization, which:

1. Checks for existing configuration
2. If no PKP exists, automatically:
   - Creates a new EVM wallet
   - Generates a Solana wallet
   - Mints a new PKP
   - Mints a capacity credit NFT
   - Saves all configurations to `lit-config.json`

## Configuration File Structure

The `lit-config.json` file is automatically created with the following structure:

```json
{
"pkp": {
"tokenId": "0xca60...", // The PKP token ID
"publicKey": "04b756...", // The PKP public key
"ethAddress": "0xB2D4...", // The Ethereum address
"solanaAddress": "HzunQ..." // The Solana address
},
"network": "Chain ID 175188", // The network identifier
"timestamp": 1735839217558, // Creation timestamp
"evmWalletPrivateKey": "0x710...", // EVM wallet private key
"solanaWalletPrivateKey": "Wz0...", // Solana wallet private key (base64)
"capacityCredit": {
"tokenId": "87622" // Capacity credit NFT token ID
},
"wrappedKeyId": "0b410..." // Wrapped key identifier
}
```


### Configuration Fields Explained

#### PKP Section
- `tokenId`: Unique identifier for the PKP NFT
- `publicKey`: PKP's public key
- `ethAddress`: Generated Ethereum address
- `solanaAddress`: Generated Solana address

#### Other Fields
- `network`: Identifies the blockchain network
- `timestamp`: Creation timestamp
- `evmWalletPrivateKey`: Private key for EVM transactions
- `solanaWalletPrivateKey`: Private key for Solana transactions (base64 encoded)
- `capacityCredit.tokenId`: Used for rate limiting and usage tracking
- `wrappedKeyId`: Used for secure key management with Lit Protocol

## Security Considerations

The `lit-config.json` file contains sensitive information. Important security measures:

1. Add to `.gitignore`
2. Never share or expose the file
3. Maintain secure backups
4. Store in a safe location

## Required Environment Variables

Set these environment variables for proper PKP creation:

```env
FUNDING_PRIVATE_KEY= # Private key for funding operations
RPC_URL= # RPC endpoint for blockchain interactions
```


## Optional Manual Configuration

There are two ways to use an existing PKP instead of automatic creation:

1. Set the environment variable:
```env
LIT_PKP_PUBLIC_KEY=   # Your existing PKP public key
```

2. Copy an existing `lit-config.json` file:
   - Simply copy your existing `lit-config.json` file into your project's root directory
   - The plugin will detect and use this configuration instead of creating a new one
   - Ensure the copied configuration file contains all required fields
   - This is useful for maintaining the same PKP across multiple environments or projects

> Note: When copying an existing configuration, make sure to maintain proper security practices and never commit the file to version control.


## Verification Steps

Verify your setup by checking:

1. `lit-config.json` exists in your project
2. PKP configuration is valid
3. Capacity credit NFT is allocated

The plugin handles ongoing PKP rotation and management automatically based on the configuration.

## Support

For additional support or questions:
- Visit the [Lit Protocol Documentation](https://developer.litprotocol.com/)
- Join the [Lit Protocol Discord](https://discord.com/invite/lit)