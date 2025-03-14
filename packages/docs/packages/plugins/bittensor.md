# @elizaos/plugin-bittensor

A plugin that integrates BitMind's API into ElizaOS agents, enabling access to AI services and digital assets powered by the Bittensor network.

## Description
The Bittensor plugin enables agents to interact with BitMind's API to access a range of AI capabilities on Bittensor's decentralized network, including inference, media generation, and deepfake detection services. Currently, the plugin offers image detection functionality to determine if images are AI-generated, with additional capabilities planned for future releases through the BitMind API.

## Installation

```bash
pnpm install @elizaos/plugin-bittensor
```

## Features

### SN34 - Deepfake Detection
The plugin currently implements BitMind's SN34 subnet for AI-generated image detection. This subnet provides:
- Real-time analysis of image authenticity
- Confidence scoring for AI influence detection
- Detailed response formatting with:
  - Binary classification (AI vs Natural image)
  - Percentage-based AI influence rating
  - Risk assessment based on confidence levels
  - Visual indicators for quick interpretation (🤖, 📸, ⚠️, ⚡, ✅)