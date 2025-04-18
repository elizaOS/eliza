# Akash Network Plugin for Eliza

## Purpose

A powerful plugin for interacting with the Akash Network, enabling deployment management and cloud compute operations through Eliza.

## Installation

```bash
bun add @elizaos/plugin-akash
```

## Configuration

### Environment Variables

Requires a `.env` file with network configuration, transaction settings, authentication (including AKASH_MNEMONIC), manifest settings, and deployment settings.

### Directory Structure

- SDL files stored in `src/sdl/`
- SSL certificates stored in `src/.certificates/`

## Available Actions

- CREATE_DEPLOYMENT
- CLOSE_DEPLOYMENT
- GET_PROVIDER_INFO
- GET_DEPLOYMENT_STATUS
- GET_GPU_PRICING
- GET_MANIFEST
- GET_PROVIDERS_LIST

## Error Handling

Includes specific error codes for SDL validation, wallet initialization, deployment creation, API requests, manifest parsing, and provider filtering issues.
