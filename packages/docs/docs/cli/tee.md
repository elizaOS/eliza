---
sidebar_position: 6
title: Tee
description: Manage TEE deployments on ElizaOS
keywords: [CLI, TEE, Phala, Trusted Execution Environment, deployment]
---

# ElizaOS Tee

The `tee` command provides access to Trusted Execution Environment (TEE) deployment and management capabilities through integrated vendor CLIs.

## Overview

TEE (Trusted Execution Environment) enables secure and verifiable agent operations on blockchain. The `tee` command currently supports Phala Cloud as a TEE provider, with the potential for additional vendors in the future.

## Installation

```bash
bun install -g @elizaos/cli
```

## Command Structure

```bash
elizaos tee <vendor> [vendor-specific-commands]
```

## Available Vendors

### Phala Cloud

The `phala` subcommand provides a wrapper for the official Phala Cloud CLI, allowing you to manage TEE deployments on Phala Cloud directly through ElizaOS.

```bash
elizaos tee phala [phala-cli-commands]
```

The Phala CLI will be automatically downloaded via npx if not already installed.

## Usage Examples

### Get Phala CLI Help

```bash
# Display Phala CLI help
elizaos tee phala help

# Get help for a specific Phala command
elizaos tee phala cvms help
```

### Authentication

```bash
# Login to Phala Cloud with your API key
elizaos tee phala auth login <api-key>

# Check authentication status
elizaos tee phala auth status
```

### Managing CVMs (Confidential Virtual Machines)

```bash
# List all CVMs
elizaos tee phala cvms list

# Create a new CVM
elizaos tee phala cvms create --name my-agent-app --compose ./docker-compose.yml

# Get CVM details
elizaos tee phala cvms get <cvm-id>

# Update a CVM
elizaos tee phala cvms update <cvm-id> --compose ./docker-compose.yml

# Delete a CVM
elizaos tee phala cvms delete <cvm-id>
```

### TEE Agent Deployment

For deploying ElizaOS agents to TEE environments:

1. First, create a TEE-compatible project:

   ```bash
   elizaos create my-tee-agent --type tee
   ```

2. Configure your agent and prepare deployment files

3. Deploy to Phala Cloud:
   ```bash
   elizaos tee phala cvms create --name my-tee-agent --compose ./docker-compose.yml
   ```

## Configuration

### Prerequisites

- Node.js and npm/npx installed (required for automatic Phala CLI installation)
- Phala Cloud account and API key (for deployment operations)
- Docker compose file for CVM deployments

### Environment Variables

When deploying TEE agents, ensure your environment variables are properly configured:

```bash
# Set up your Phala API key
export PHALA_API_KEY="your-api-key"

# Or add to your .env file
echo "PHALA_API_KEY=your-api-key" >> .env
```

## Advanced Usage

### Direct Phala CLI Access

All Phala CLI commands and options are available through the wrapper:

```bash
# Any Phala CLI command can be used
elizaos tee phala [any-phala-command] [options]
```

For the complete list of Phala CLI commands and options, run:

```bash
elizaos tee phala help
```

Or visit the official Phala CLI documentation:

```bash
npx phala help
```

## Troubleshooting

### Common Issues

1. **npx not found**: Install Node.js and npm from [nodejs.org](https://nodejs.org) or use a version manager like nvm:

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   ```

2. **Authentication failures**: Ensure your API key is valid and you're logged in:

   ```bash
   elizaos tee phala auth login <api-key>
   ```

3. **Deployment errors**: Check your docker-compose.yml file is valid and all required services are defined

### Debug Mode

For detailed output when troubleshooting:

```bash
# Run with verbose logging
LOG_LEVEL=debug elizaos tee phala cvms list
```

## Integration with ElizaOS

TEE deployments enable:

- **Secure key management**: Private keys never leave the TEE
- **Verifiable computation**: Cryptographic proof of agent behavior
- **Blockchain integration**: Direct onchain operations with attestation
- **Privacy preservation**: Sensitive data processing in secure enclaves

## Related Documentation

- [Creating TEE Projects](./create.md#tee-projects)
- [TEE Plugin Documentation](/packages/plugins/tee)
- [Phala Cloud Documentation](https://docs.phala.network/)

## Security Considerations

When deploying agents to TEE:

1. Never commit private keys or sensitive configuration
2. Use environment variables for secrets
3. Verify attestation reports for production deployments
4. Follow Phala Cloud security best practices

---
