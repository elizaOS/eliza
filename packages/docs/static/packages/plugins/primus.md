# @elizaos/plugin-primus

## Purpose

A plugin to fully verify agent activities, including LLM access, actions, and interactions with external providers, powered by Primus' zkTLS protocol.

## Key Features

- Verification of inference from OpenAI's LLM
- Example for verifying actions (like posting tweets)
- Example to verify Bitcoin price fetched from Binance

## Installation

```bash
bun add @elizaos/plugin-primus
```

## Configuration

Add to .env file:

```
PRIMUS_APP_ID=your_app_id
PRIMUS_APP_SECRET=your_app_secret
VERIFIABLE_INFERENCE_ENABLED=true
VERIFIABLE_INFERENCE_PROVIDER=primus
```

Get credentials by:

1. Visit the Primus Developer Hub
2. Create a new project
3. Save Application ID and Secret Key

Add plugin to character file:

```json
{
  "plugins": ["@elizaos/plugin-primus"]
}
```

## Integration

Implements `IVerifiableInferenceAdapter` through the `PrimusAdapter` class for verification of LLM interactions, actions, and provider data.

## Example Usage

- LLM inference verification using PrimusAdapter
- Verify BTC price from Binance
- Post verified tweets with price information

## Links

[Primus Developer Hub](https://dev.primuslabs.xyz/)
