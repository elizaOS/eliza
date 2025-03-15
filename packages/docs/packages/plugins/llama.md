# @elizaos/plugin-llama

Core LLaMA plugin for Eliza OS that provides local Large Language Model capabilities.

## Overview

The LLaMA plugin serves as a foundational component of Eliza OS, providing local LLM capabilities using LLaMA models. It enables efficient and customizable text generation with both CPU and GPU support.

## Features

- **Local LLM Support**: Run LLaMA models locally
- **GPU Acceleration**: CUDA support for faster inference
- **Flexible Configuration**: Customizable parameters for text generation
- **Message Queuing**: Efficient handling of multiple requests
- **Automatic Model Management**: Download and verification systems

## Installation

```bash
npm install @elizaos/plugin-llama
```

## Configuration

The plugin can be configured through environment variables:

### Core Settings

```env
LLAMALOCAL_PATH=your_model_storage_path
OLLAMA_MODEL=optional_ollama_model_name
```

## Usage

```typescript
import { createLlamaPlugin } from "@elizaos/plugin-llama";

// Initialize the plugin
const llamaPlugin = createLlamaPlugin();

// Register with Eliza OS
elizaos.registerPlugin(llamaPlugin);
```

## Services

### LlamaService

Provides local LLM capabilities using LLaMA models.

#### Technical Details

- **Model**: Hermes-3-Llama-3.1-8B (8-bit quantized)
- **Source**: Hugging Face (NousResearch/Hermes-3-Llama-3.1-8B-GGUF)
- **Context Size**: 8192 tokens
- **Inference**: CPU and GPU (CUDA) support

#### Features

1. **Text Generation**
   - Completion-style inference
   - Temperature control
   - Stop token configuration
   - Frequency and presence penalties
   - Maximum token limit control

2. **Model Management**
   - Automatic model downloading
   - Model file verification
   - Automatic retry on initialization failures
   - GPU detection for acceleration

3. **Performance**
   - Message queuing system
   - CUDA acceleration when available
   - Configurable context size

## Troubleshooting

### Common Issues

1. **Model Initialization Failures**

```bash
Error: Model initialization failed
```

- Verify model file exists and is not corrupted
- Check available system memory
- Ensure CUDA is properly configured (if using GPU)

2. **Performance Issues**

```bash
Warning: No CUDA detected - local response will be slow
```

- Verify CUDA installation if using GPU
- Check system resources
- Consider reducing context size

### Debug Mode

Enable debug logging for detailed troubleshooting:

```typescript
process.env.DEBUG = "eliza:plugin-llama:*";
```

### System Requirements

- Node.js 16.x or higher
- Minimum 8GB RAM recommended
- CUDA-compatible GPU (optional, for acceleration)
- Sufficient storage for model files

### Performance Optimization

1. **Model Selection**
   - Choose appropriate model size
   - Use quantized versions when possible
   - Balance quality vs speed

2. **Resource Management**
   - Monitor memory usage
   - Configure appropriate context size
   - Optimize batch processing

3. **GPU Utilization**
   - Enable CUDA when available
   - Monitor GPU memory
   - Balance CPU/GPU workload

## Support

For issues and feature requests, please:

1. Check the troubleshooting guide above
2. Review existing GitHub issues
3. Submit a new issue with:
    - System information
    - Error logs
    - Steps to reproduce

## Credits

This plugin integrates with and builds upon:

- [LLaMA](https://github.com/facebookresearch/llama) - Base language model
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) - Node.js bindings
- [GGUF](https://github.com/ggerganov/ggml) - Model format

Special thanks to:

- The LLaMA community for model development
- The Node.js community for tooling support
- The Eliza community for testing and feedback

## License

This plugin is part of the Eliza project. See the main project repository for license information.
