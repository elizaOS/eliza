# @elizaos/plugin-tts

A plugin for text-to-speech(TTS) generation using the FAL.ai API within the ElizaOS ecosystem.

## Description

The text-to-speech(TTS) plugin enables AI-powered creation of speech through FAL.ai's services. It provides functionality to generate audio from text descriptions, automatically detects language, and selects appropriate voice models.

## Installation

```bash
pnpm install @elizaos/plugin-tts
```

## Configuration

The plugin requires the following environment variable or runtime setting to be set:

```typescript
FAL_API_KEY=<Your FAL.ai API key>
```

## Usage

### Basic Integration

```typescript
import { TTSGenerationPlugin } from "@elizaos/plugin-tts";
```

### Voice Generation Examples

```typescript
// The plugin responds to natural language commands like:

"Generate TTS of Hello World";
"Create a TTS for Welcome to ElizaOS";
"Make a TTS saying [your text]";
```

## API Reference

### Actions

#### GENERATE_TTS

Generates speech audio based on text input.

**Aliases:**
- TTS_GENERATION
- CREATE_TTS
- TEXT2SPEECH
- T2S
- TEXT_TO_SPEECH
- AUDIO_CREATE

**Features:**
- Automatic language detection
- Voice selection based on detected language
- Local file caching
- Progress tracking
- Error handling

## Common Issues & Troubleshooting

1. **Generation Failures**
    - Verify FAL API key is correctly set
    - Ensure text input is at least 3 characters long
    - Check network connectivity to FAL.ai services

2. **Storage Issues**
    - Verify write permissions to content_cache directory
    - Ensure sufficient disk space
    - Check if content_cache directory exists

## Security Best Practices

1. **API Key Management**
    - Store FAL API key securely using runtime settings or environment variables
    - Never commit API keys to version control
    - Monitor API usage

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

1. **Advanced Voice Features**
    - Custom voice model support
    - Voice style transfer
    - Emotion control
    - Speech rate adjustment
    - Pitch modification
    - Multiple speaker support

2. **Audio Processing**
    - Background noise reduction
    - Audio quality enhancement
    - Format conversion options
    - Volume normalization
    - Audio effects processing
    - Batch processing support

3. **Language Support**
    - Expanded language detection
    - Regional accent support
    - Dialect customization
    - Pronunciation improvements
    - Multi-language mixing
    - Custom pronunciation rules

4. **Integration Features**
    - Streaming audio support
    - Real-time generation
    - Caching optimization
    - Batch generation
    - Queue management
    - Progress monitoring

5. **Developer Tools**
    - Extended API options
    - Testing framework
    - Performance profiling
    - Debug logging
    - Integration examples
    - Documentation generator

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the CONTRIBUTING.md file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [FAL.ai](https://fal.ai/): AI model deployment platform
- [langdetect](https://github.com/wooorm/franc): Language detection library
- [ElizaOS](https://elizaos.com): Core framework

Special thanks to:
- The FAL.ai team for AI infrastructure
- The langdetect development community
- The Eliza community for their contributions and feedback

For more information about TTS capabilities:
- [FAL.ai Documentation](https://fal.ai/docs)
- [ElizaOS Documentation](https://elizaos.github.io/eliza/)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
