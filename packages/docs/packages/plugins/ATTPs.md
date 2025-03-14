
# @elizaos/plugin-attps

Foundation plugin that enables advanced agent interactions, data verification, and price queries on the Eliza OS platform. It streamlines agent creation, verification processes, and provides a flexible framework for building robust agent-based solutions.

## Overview

The ATTPs plugin bridges agent-based logic with the Eliza ecosystem. It handles agent registration, data verification, and price queries, empowering both automated and user-driven workflows.

## Features

### Agent Operations
- **Agent Creation**: Deploy new agents with custom settings
- **Registration**: Register agents on-chain or via standardized processes
- **Multi-Signer Framework**: Supports threshold-based approval flows

### Data Verification
- **Chain Validation**: Verify data authenticity on-chain
- **Transaction Execution**: Handle verification logic with built-in security checks
- **Auto-Hashing**: Convert raw data to hashed formats when needed
- **Metadata Parsing**: Validate content type, encoding, and compression

### Price Queries
- **Live Price Data**: Fetch price information for various pairs
- **Format Validation**: Normalize user query inputs to standard trading-pair formats
- **APIs Integration**: Retrieve real-time or near-real-time pricing information

## Security Features

### Access Control
- **Private Key Management**: Safe usage of private keys for transaction signing
- **Environment Variables**: Secure injection of credentials
- **On-Chain Validation**: Leverage on-chain contract checks

### Verification
- **Input Validation**: Strict schema checks before on-chain operations
- **Transaction Receipts**: Provide verifiable transaction details
- **Error Handling**: Detailed error logs for quick debugging

## Installation

```bash
npm install @elizaos/plugin-attps
```

## Configuration

Configure the plugin by setting environment variables or runtime settings:
- ATTPS_RPC_URL
- ATTPS_PROXY_ADDRESS
- ATTPS_PRIVATE_KEY
- ATTPS_CONVERTER_ADDRESS
- ATTPS_AUTO_HASH_DATA

## Usage

### Basic Setup
```typescript
import { attpsPlugin } from "@elizaos/plugin-attps";

// Initialize the plugin
const runtime = await initializeRuntime({
    plugins: [attpsPlugin],
});
```

### Actions

#### CREATE_AND_REGISTER_AGENT
Creates and registers an agent using specified settings.

```typescript
const result = await runtime.executeAction("CREATE_AND_REGISTER_AGENT", {
    signers: [...],
    threshold: 3,
    agentHeader: { ... },
    // ...other fields...
});
```

#### VERIFY
Verifies data on-chain via the Agent SDK.

```typescript
const result = await runtime.executeAction("VERIFY", {
    payload: {
        data: "0x...hexData",
        signatures: [...],
    },
    agent: "0x...agentAddress",
    digest: "0x...digestString",
});
```

#### PRICE_QUERY
Fetches live price data for a specified trading pair.

```typescript
const result = await runtime.executeAction("PRICE_QUERY", {
    pair: "BTC/USD",
});
```

## Performance Optimization

1. **Cache Management**
   - Implement caching for frequent queries
   - Monitor retrieval times and cache hits

2. **Network Efficiency**
   - Batch requests where possible
   - Validate response parsing to reduce overhead

## System Requirements
- Node.js 16.x or higher
- Sufficient network access to on-chain endpoints
- Basic configuration of environment variables
- Minimum 4GB RAM recommended

## Troubleshooting

1. **Invalid Agent Settings**
   - Ensure signers and threshold are correct
   - Validate agentHeader for proper UUIDs and numeric values

2. **Verification Failures**
   - Check the input data formats
   - Confirm environment variables are set

3. **Price Query Errors**
   - Verify the trading pair format
   - Check external API availability

## Safety & Security

1. **Credential Management**
   - Store private keys securely
   - Do not commit secrets to version control

2. **Transaction Limits**
   - Configure thresholds to mitigate abuse
   - Log transaction attempts and failures

3. **Monitoring & Logging**
   - Track unusual activity
   - Maintain detailed audit logs

## Support

For issues or feature requests:
1. Check existing documentation
2. Submit a GitHub issue with relevant details
3. Include transaction logs and system info if applicable

## Contributing

We welcome pull requests! Refer to the project’s CONTRIBUTING.md and open discussions to coordinate efforts.

## Credits

- [APRO](https://www.apro.com/) - Plugin sponsor and partner
- [ATTPs SDK JS](https://github.com/APRO-com/attps-sdk-js) - Underlying agent SDK
- [ethers.js](https://docs.ethers.io/) - Transaction and contract interaction
- Community contributors for feedback and testing

For more information about Apro plugin capabilities:

- [Apro Documentation](https://docs.apro.com/en)

## License

This plugin is part of the Eliza project. Refer to the main project repository for licensing details.