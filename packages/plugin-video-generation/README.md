# @elizaos/plugin-video-generation

A plugin for AI-powered video generation using Luma AI, providing automated video creation capabilities from text prompts.

## Overview

This plugin provides functionality to:
- Generate videos from text descriptions
- Handle video generation requests through Luma AI
- Manage API authentication and responses
- Cache and serve generated videos
- Monitor generation progress

## Installation

```bash
npm install @elizaos/plugin-video-generation
```

## Configuration

The plugin requires the following environment variables:

```env
LUMA_API_KEY=your_luma_api_key    # Required: API key for Luma AI
```

## Usage

Import and register the plugin in your Eliza configuration:

```typescript
import { videoGenerationPlugin } from "@elizaos/plugin-video-generation";

export default {
  plugins: [videoGenerationPlugin],
  // ... other configuration
};
```

## Features

### Video Generation

The plugin uses Luma AI's API to generate videos from text prompts:

```typescript
import { videoGeneration } from "@elizaos/plugin-video-generation";

// Generate video from prompt
const result = await videoGeneration.handler(runtime, {
    content: { text: "Generate a video of a sunset on the beach" }
}, state, {}, callback);
```

### Progress Monitoring

```typescript
// The plugin automatically handles progress monitoring
const result = await generateVideo(prompt, runtime);
if (result.success) {
    console.log("Video URL:", result.data);
} else {
    console.error("Generation failed:", result.error);
}
```

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

### Development Mode

```bash
npm run dev
```

## Dependencies

- `@elizaos/core`: Core Eliza functionality
- `tsup`: Build tool
- Other standard dependencies listed in package.json

## API Reference

### Core Interfaces

```typescript
interface Action {
    name: "GENERATE_VIDEO";
    similes: string[];
    description: string;
    validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
    handler: (runtime: IAgentRuntime, message: Memory, state: State, options: any, callback: HandlerCallback) => Promise<void>;
    examples: Array<Array<any>>;
}

interface GenerationResult {
    success: boolean;
    data?: string;
    error?: string;
}
```

### Plugin Methods

- `generateVideo`: Main method for video generation
- `videoGeneration.handler`: Action handler for video requests
- `videoGeneration.validate`: Validates API key and requirements

## Common Issues/Troubleshooting

### Issue: API Authentication Failures
- **Cause**: Invalid or missing Luma API key
- **Solution**: Verify LUMA_API_KEY environment variable

### Issue: Generation Timeouts
- **Cause**: Long generation times or network issues
- **Solution**: Implement proper timeout handling and retry logic

### Issue: File Storage Errors
- **Cause**: Insufficient permissions or disk space
- **Solution**: Verify file system permissions and available storage

## Security Best Practices

- Store API keys securely using environment variables
- Implement proper error handling
- Keep dependencies updated
- Monitor API usage and rate limits
- Validate input prompts
- Secure file storage handling

## Constants

The plugin uses predefined constants for API configuration:

```typescript
export const LUMA_CONSTANTS = {
    API_URL: "https://api.lumalabs.ai/dream-machine/v1/generations",
    API_KEY_SETTING: "LUMA_API_KEY"
};
```

## Example Usage

```typescript
// Basic video generation
const videoPrompt = "Create a video of a futuristic city at night";
const result = await generateVideo(videoPrompt, runtime);

// With callback handling
videoGeneration.handler(runtime, {
    content: { text: videoPrompt }
}, state, {}, (response) => {
    console.log("Generation status:", response);
});
```

## Future Enhancements

1. **Generation Features**
   - Advanced style control
   - Multi-scene composition
   - Custom duration settings
   - Resolution options
   - Frame rate control
   - Audio integration

2. **Video Editing**
   - Scene transitions
   - Text overlay tools
   - Effect templates
   - Color correction
   - Motion tracking
   - Timeline editing

3. **Asset Management**
   - Asset library
   - Template system
   - Style presets
   - Resource optimization
   - Version control
   - Batch processing

4. **Quality Improvements**
   - Enhanced resolution
   - Frame interpolation
   - Artifact reduction
   - Stability features
   - Lighting optimization
   - Detail enhancement

5. **Performance Optimization**
   - Generation speed
   - Resource usage
   - Parallel processing
   - Caching system
   - Queue management
   - Load balancing

6. **Export Options**
   - Multiple formats
   - Compression settings
   - Streaming support
   - Progressive loading
   - Thumbnail generation
   - Metadata handling

7. **Developer Tools**
   - API expansion
   - Testing framework
   - Documentation generator
   - Debug visualization
   - Performance monitoring
   - Integration templates

8. **AI Features**
   - Style transfer
   - Scene understanding
   - Content awareness
   - Motion synthesis
   - Character animation
   - Environment generation

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Luma AI](https://lumalabs.ai/): Advanced AI-powered video generation platform
- [Luma Dream Machine](https://lumalabs.ai/dream-machine): Text-to-video generation API
- [Node.js Fetch API](https://nodejs.org/api/fetch.html): HTTP request handling

Special thanks to:
- The Luma Labs team for providing the video generation API
- The Luma AI research team for their groundbreaking work in AI video generation
- The Eliza community for their contributions and feedback

For more information about video generation capabilities and tools:
- [Luma AI Documentation](https://docs.lumalabs.ai/)
- [Dream Machine API Reference](https://lumalabs.ai/docs/dream-machine)
- [Video Generation Best Practices](https://lumalabs.ai/docs/best-practices)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
