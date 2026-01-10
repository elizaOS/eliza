# @elizaos/plugin-sam

Retro 1980s SAM Text-to-Speech plugin for ElizaOS agents.

## Overview

This plugin integrates the classic SAM (Software Automatic Mouth) text-to-speech synthesizer from the 1980s into ElizaOS agents. SAM was originally developed by Don't Ask Software and became famous for its distinctive robotic voice synthesis.

## Features

- 🎙️ **Authentic Retro Voice**: Uses the original SAM algorithm for genuine 1980s TTS
- 🔊 **Hardware Bridge Integration**: Outputs audio through system speakers
- ⚙️ **Voice Parameter Control**: Adjust speed, pitch, throat, and mouth settings
- 🎯 **Trigger Word Detection**: Responds to "say aloud", "speak", and voice commands
- 📡 **WebSocket Audio Streaming**: Real-time audio delivery to connected clients
- 🎵 **WAV Format Output**: Standard audio format for compatibility

## Installation

```bash
npm install @elizaos/plugin-sam
```

## Usage

### Basic Setup

```typescript
import { samPlugin } from '@elizaos/plugin-sam';
import { AgentRuntime } from '@elizaos/core';

const runtime = new AgentRuntime({
  character: yourCharacter,
  plugins: [samPlugin],
  // ... other configuration
});
```

### Using the SAY_ALOUD Action

The plugin responds to messages containing trigger words:

```
User: "Please say aloud: Hello from the past!"
Agent: [Generates retro SAM voice audio saying "Hello from the past!"]

User: "Speak this text: Welcome to 1985"
Agent: [Generates retro SAM voice audio saying "Welcome to 1985"]
```

### Voice Parameters

You can control various aspects of the SAM voice:

- **Speed**: 20-200 (default: 72)
- **Pitch**: 0-255 (default: 64)
- **Throat**: 0-255 (default: 128)
- **Mouth**: 0-255 (default: 128)

### Hardware Bridge Integration

The plugin integrates with ElizaOS's hardware bridge service to output audio through system speakers. When a SAY_ALOUD action is triggered:

1. Text is processed by the SAM synthesizer
2. Audio buffer is generated in WAV format
3. Audio is streamed via WebSocket to the hardware bridge
4. Hardware bridge plays audio through system speakers

## API Reference

### Actions

#### SAY_ALOUD

Synthesizes text using SAM TTS and outputs through speakers.

**Triggers**: Messages containing "say aloud", "speak", or similar voice commands

**Parameters**: Extracted from message content

**Returns**: Audio output through hardware bridge

### Services

#### SamTTSService

Core service managing SAM text-to-speech functionality.

**Methods**:

- `generateAudio(text, options)` - Generate SAM audio buffer
- `speakText(text, options)` - Generate and stream audio
- `createWAVBuffer(audioData)` - Convert SAM output to WAV format

## Voice Examples

The classic SAM voice is distinctive and immediately recognizable:

- **"Hello world"** - Basic greeting with robotic charm
- **"Welcome to the future"** - Sci-fi themed announcement
- **"System online"** - Computer status message
- **"Error detected"** - Alert notification

## Technical Details

### SAM Algorithm

The plugin uses the `sam-js` library, which is a JavaScript port of the original SAM speech synthesis algorithm. This ensures authentic 1980s voice characteristics including:

- Formant-based synthesis
- Distinctive robotic tone
- Authentic phoneme processing
- Classic pitch and timing patterns

### Audio Pipeline

```
Text Input → SAM Synthesis → WAV Buffer → WebSocket → Hardware Bridge → System Speakers
```

### Dependencies

- `sam-js`: Core SAM synthesis library
- `@elizaos/core`: ElizaOS framework
- Hardware bridge service for audio output

## Testing

Run the test suite:

```bash
npm test
```

Test with ElizaOS:

```bash
elizaos test
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Credits

- Original SAM algorithm by Don't Ask Software (1982)
- JavaScript port by Vidar Hokstad and contributors
- ElizaOS integration by the ElizaOS team

## Troubleshooting

### No Audio Output

1. Verify hardware bridge service is running
2. Check system audio settings
3. Ensure WebSocket connection is established
4. Test with other audio applications

### Synthesis Issues

1. Check text contains valid characters
2. Verify SAM parameters are within valid ranges
3. Test with simple text first
4. Review error logs for synthesis failures

For more help, see the [ElizaOS documentation](https://elizaos.ai/docs) or [open an issue](https://github.com/ai16z/eliza/issues).
