# @elizaos/plugin-llama

## Purpose

Core LLaMA plugin for Eliza OS that provides local Large Language Model capabilities.

## Key Features

- Local LLM Support: Run LLaMA models locally
- GPU Acceleration: CUDA support for faster inference
- Flexible Configuration: Customizable parameters for text generation
- Message Queuing: Efficient handling of multiple requests
- Automatic Model Management: Download and verification systems

## Installation

```bash
bun install @elizaos/plugin-llama
```

## Configuration

The plugin can be configured through environment variables:

```env
LLAMALOCAL_PATH=your_model_storage_path
OLLAMA_MODEL=optional_ollama_model_name
```

## Integration

```typescript
import { createLlamaPlugin } from '@elizaos/plugin-llama';

// Initialize the plugin
const llamaPlugin = createLlamaPlugin();

// Register with Eliza OS
elizaos.registerPlugin(llamaPlugin);
```
