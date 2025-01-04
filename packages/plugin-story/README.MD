# @elizaos/plugin-story

The Story Protocol plugin enables interaction with Story Protocol's IP management and licensing system on the Odyssey testnet.

## Overview

This plugin provides functionality to:

- Register IP assets on Story Protocol
- License IP assets
- Attach license terms to IP assets
- Query IP asset details and available licenses
- Manage wallet interactions with Story Protocol

## Installation

```bash
pnpm install @elizaos/plugin-story
```

## Configuration

The plugin requires the following environment variables:

```env
STORY_PRIVATE_KEY=your_private_key
STORY_API_KEY=your_api_key
STORY_API_BASE_URL=https://api.story.xyz
PINATA_JWT=your_pinata_jwt_token
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { storyPlugin } from "@elizaos/plugin-story";

export default {
    plugins: [storyPlugin],
    // ... other configuration
};
```

## Features

### Register IP

Register a new IP asset on Story Protocol:

```typescript
// Example conversation
User: "I want to register my IP titled 'My Story' with the description 'An epic tale'";
Assistant: "I'll help you register your IP on Story Protocol...";
```

### License IP

License an existing IP asset:

```typescript
// Example conversation
User: "I want to license IP Asset 0x1234...5678 with license terms ID 1";
Assistant: "I'll help you license that IP asset...";
```

### Attach Terms

Attach license terms to an IP asset:

```typescript
// Example conversation
User: "I want to attach commercial license terms with 10% revenue share to IP 0x1234...5678";
Assistant: "I'll help you attach those license terms...";
```

### Get IP Details

Query details about an IP asset:

```typescript
// Example conversation
User: "Get details for IP Asset 0x1234...5678";
Assistant: "Here are the details for that IP asset...";
```

### Get Available Licenses

Query available licenses for an IP asset:

```typescript
// Example conversation
User: "What licenses are available for IP Asset 0x1234...5678?";
Assistant: "Here are the available licenses...";
```

## API Reference

### Actions

- `REGISTER_IP`: Register a new IP asset
- `LICENSE_IP`: License an existing IP asset
- `ATTACH_TERMS`: Attach license terms to an IP
- `GET_IP_DETAILS`: Get details about an IP
- `GET_AVAILABLE_LICENSES`: Get available licenses for an IP

### Providers

- `storyWalletProvider`: Manages wallet interactions with Story Protocol

## Development

### Building

```bash
pnpm run build
```

### Testing

```bash
pnpm run test
```

## Dependencies

- `@story-protocol/core-sdk`: Core SDK for Story Protocol
- `@pinata/sdk`: IPFS pinning service
- `viem`: Ethereum interaction library
- Other standard dependencies listed in package.json

## Future Enhancements

The following features and improvements are planned for future releases:

1. **IP Management**

    - Batch IP registration
    - Advanced metadata management
    - IP relationship mapping
    - Automated IP verification
    - Collection management
    - IP analytics dashboard

2. **Licensing Features**

    - Custom license templates
    - License negotiation tools
    - Automated royalty distribution
    - Usage tracking system
    - License violation detection
    - Bulk licensing tools

3. **Rights Management**

    - Advanced permission systems
    - Rights transfer automation
    - Usage rights tracking
    - Derivative works management
    - Rights verification tools
    - Dispute resolution system

4. **Smart Contract Integration**

    - Contract deployment templates
    - Automated verification
    - Contract upgrade system
    - Security analysis tools
    - Gas optimization
    - Multi-signature support

5. **Content Management**

    - Media file handling
    - Content versioning
    - Distribution tracking
    - Content authentication
    - Storage optimization
    - Format conversion tools

6. **Revenue Management**

    - Automated payments
    - Revenue sharing tools
    - Payment tracking
    - Financial reporting
    - Tax documentation
    - Audit trail system

7. **Developer Tools**

    - Enhanced SDK features
    - Testing framework
    - Documentation generator
    - CLI improvements
    - Integration templates
    - Performance monitoring

8. **Analytics and Reporting**
    - Usage statistics
    - Revenue analytics
    - License tracking
    - Performance metrics
    - Custom reporting
    - Market analysis tools

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Story Protocol](https://www.story.xyz/): IP management and licensing platform
- [@story-protocol/core-sdk](https://www.npmjs.com/package/@story-protocol/core-sdk): Official Story Protocol SDK
- [@pinata/sdk](https://www.npmjs.com/package/@pinata/sdk): IPFS pinning service
- [viem](https://www.npmjs.com/package/viem): Ethereum interaction library

Special thanks to:

- The Story Protocol team for developing the IP management platform
- The Story Protocol Developer community
- The Pinata team for IPFS infrastructure
- The Eliza community for their contributions and feedback

For more information about Story Protocol capabilities:

- [Story Protocol Documentation](https://docs.story.xyz/)
- [Story Protocol Dashboard](https://app.story.xyz/)
- [Story Protocol Blog](https://www.story.xyz/blog)
- [Story Protocol GitHub](https://github.com/storyprotocol)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
