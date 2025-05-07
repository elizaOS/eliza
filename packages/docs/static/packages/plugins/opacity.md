# @elizaos/adapter-opacity

## Purpose

This adapter integrates Opacity proofs into ElizaOS, enabling verifiable inference results from AI model providers through the CloudFlare AI Gateway.

## Key Features

- Implements `IVerifiableInferenceAdapter` interface for standardized verifiable inference
- Support for multiple AI model providers
- Customizable options for each request
- Built-in proof verification

## Installation

```bash
bun add @elizaos/adapter-opacity
```

## Configuration

Add environment variables to your `.env` file:

```env
OPACITY_TEAM_ID=f309ac8ae8a9a14a7e62cd1a521b1c5f
OPACITY_CLOUDFLARE_NAME=eigen-test
OPACITY_PROVER_URL=https://opacity-ai-zktls-demo.vercel.app
VERIFIABLE_INFERENCE_ENABLED=true
VERIFIABLE_INFERENCE_PROVIDER=opacity
```

## Integration

The adapter wraps AI model API calls to CloudFlare, performs MPC-TLS on logged responses, enabling verifiable API calls, proof generation, and verification of response authenticity.

## Example Usage

```typescript
import { OpacityAdapter } from '@elizaos/adapter-opacity';
import { VerifiableInferenceOptions } from '@elizaos/core';

// Initialize the adapter
const opacityAdapter = new OpacityAdapter(runtime, {
  teamId: process.env.OPACITY_TEAM_ID,
  teamName: process.env.OPACITY_CLOUDFLARE_NAME,
  baseUrl: process.env.OPACITY_PROVER_URL,
});

// Generate text with verifiable results
const result = await opacityAdapter.generateText('What is Rust?', 'gpt-4', options);

// Verify the proof
const isValid = await opacityAdapter.verifyProof(result);
```

## Links

MIT License
