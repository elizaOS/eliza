# @elizaos/plugin-0g

A plugin for storing data using the 0G protocol within the ElizaOS ecosystem.

## Description
The 0G plugin enables seamless integration with the Zero Gravity (0G) protocol for decentralized file storage. It provides functionality to upload files to the 0G network.

## Installation

```bash
pnpm install @elizaos/plugin-0g
```

## Configuration

The plugin requires the following environment variables to be set:
```typescript
ZEROG_INDEXER_RPC=<0G indexer RPC endpoint>
ZEROG_EVM_RPC=<0G EVM RPC endpoint>
ZEROG_PRIVATE_KEY=<Private key for transactions>
ZEROG_FLOW_ADDRESS=<0G Flow contract address>
```

## Usage

### Basic Integration

```typescript
import { zgPlugin } from '@ai16z/plugin-0g';
```


### File Upload Example

```typescript
// The plugin automatically handles file uploads when triggered
// through natural language commands like:

"Upload my document.pdf"
"Store this image.png on 0G"
"Save my resume.docx to Zero Gravity"
```


## API Reference

### Actions

#### ZG_UPLOAD

Uploads files to the 0G network.

**Aliases:**
- UPLOAD_FILE_TO_ZG
- STORE_FILE_ON_ZG
- SAVE_FILE_TO_ZG
- UPLOAD_TO_ZERO_GRAVITY
- STORE_ON_ZERO_GRAVITY
- SHARE_FILE_ON_ZG
- PUBLISH_FILE_TO_ZG

**Input Content:**
```typescript
interface UploadContent {
filePath: string;
}
```


## Common Issues & Troubleshooting

1. **File Access Errors**
   - Ensure the file exists at the specified path
   - Check file permissions
   - Verify the path is absolute or relative to the execution context

2. **Configuration Issues**
   - Verify all required environment variables are set
   - Ensure RPC endpoints are accessible
   - Confirm private key has sufficient permissions

## Security Best Practices

1. **Environment Variables**
   - Never commit private keys to version control
   - Use secure environment variable management
   - Rotate private keys periodically


## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run the plugin:

```bash
pnpm run dev
```

## Future Enhancements

- Model service deployment on 0G serving network
- 0G KV store for plugin state persistence
- Upload history and file metadata storage
- 0G as a database option for Eliza state storage
- Enhanced file path and context extraction

## Contributing

Contributions are welcome! Please see our contributing guidelines for more details.

## License

[License information needed]