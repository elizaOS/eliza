# @elizaos/plugin-node

Core Node.js plugin for Eliza OS that provides essential services and actions for file operations, media processing, and cloud integrations.

## Overview

The Node plugin serves as a foundational component of Eliza OS, bridging core Node.js capabilities with the Eliza ecosystem. It provides crucial services for file operations, media processing, speech synthesis, and cloud integrations, enabling both local and cloud-based functionality for Eliza agents.


## Features

- **AWS S3 Integration**: File upload and management with AWS S3
- **Browser Automation**: Web scraping and content extraction with Playwright
- **Image Processing**: Image description and analysis capabilities
- **PDF Processing**: PDF text extraction and parsing
- **Speech Synthesis**: Text-to-speech using ElevenLabs and VITS
- **Transcription**: Speech-to-text using various providers (OpenAI, Deepgram, Local)
- **Video Processing**: YouTube video download and transcription
- **LLaMA Integration**: Local LLM support with LLaMA models

## Installation

```bash
npm install @elizaos/plugin-node
```

## Configuration

The plugin requires various environment variables depending on which services you plan to use:

### Core Settings
```env
OPENAI_API_KEY=your_openai_api_key
```

### Voice Settings (Optional)
```env
ELEVENLABS_XI_API_KEY=your_elevenlabs_api_key
ELEVENLABS_MODEL_ID=eleven_monolingual_v1
ELEVENLABS_VOICE_ID=your_voice_id
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.75
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=0
ELEVENLABS_OUTPUT_FORMAT=pcm_16000
VITS_VOICE=en_US-hfc_female-medium
```

### AWS Settings (Optional)
```env
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=your_aws_region
AWS_S3_BUCKET=your_s3_bucket
AWS_S3_UPLOAD_PATH=your_upload_path
```

## Usage

```typescript
import { createNodePlugin } from "@elizaos/plugin-node";

// Initialize the plugin
const nodePlugin = createNodePlugin();

// Register with Eliza OS
elizaOS.registerPlugin(nodePlugin);
```

## Services

### AwsS3Service
Handles file uploads and management with AWS S3.

### BrowserService
Provides web scraping and content extraction capabilities using Playwright.

### ImageDescriptionService
Processes and analyzes images to generate descriptions.

### LlamaService
Provides local LLM capabilities using LLaMA models.

### PdfService
Extracts and processes text content from PDF files.

### SpeechService
Handles text-to-speech conversion using ElevenLabs and VITS.

### TranscriptionService
Converts speech to text using various providers.

### VideoService
Processes video content, including YouTube video downloads and transcription.

## Actions

### describeImage
Analyzes and generates descriptions for images.

```typescript
// Example usage
const result = await runtime.executeAction("DESCRIBE_IMAGE", {
    imageUrl: "path/to/image.jpg"
});
```

## Dependencies

The plugin requires several peer dependencies:
- `onnxruntime-node`: 1.20.1
- `whatwg-url`: 7.1.0

And trusted dependencies:
- `onnxruntime-node`: 1.20.1
- `sharp`: 0.33.5

## Safety & Security

### File Operations
- **Path Sanitization**: All file paths are sanitized to prevent directory traversal attacks
- **File Size Limits**: Enforced limits on upload sizes
- **Type Checking**: Strict file type validation
- **Temporary File Cleanup**: Automatic cleanup of temporary files

### API Keys & Credentials
- **Environment Isolation**: Sensitive credentials are isolated in environment variables
- **Access Scoping**: Services are initialized with minimum required permissions
- **Key Rotation**: Support for credential rotation without service interruption

### Media Processing
- **Resource Limits**: Memory and CPU usage limits for media processing
- **Timeout Controls**: Automatic termination of long-running processes
- **Format Validation**: Strict media format validation before processing

## Troubleshooting

### Common Issues

1. **Service Initialization Failures**
```bash
Error: Service initialization failed
```
- Verify environment variables are properly set
- Check service dependencies are installed
- Ensure sufficient system permissions

2. **Media Processing Errors**
```bash
Error: Failed to process media file
```
- Verify file format is supported
- Check available system memory
- Ensure ffmpeg is properly installed

3. **AWS S3 Connection Issues**
```bash
Error: AWS credentials not configured
```
- Verify AWS credentials are set
- Check S3 bucket permissions
- Ensure correct region configuration

### Debug Mode

Enable debug logging for detailed troubleshooting:
```typescript
process.env.DEBUG = 'eliza:plugin-node:*';
```

### System Requirements

- Node.js 16.x or higher
- FFmpeg for media processing
- Minimum 4GB RAM recommended
- CUDA-compatible GPU (optional, for ML features)

### Performance Optimization

1. **Cache Management**
   - Regular cleanup of `content_cache` directory
   - Implement cache size limits
   - Monitor disk usage

2. **Memory Usage**
   - Configure max buffer sizes
   - Implement streaming for large files
   - Monitor memory consumption

3. **Concurrent Operations**
   - Adjust queue size limits
   - Configure worker threads
   - Monitor process pool

## Support

For issues and feature requests, please:
1. Check the troubleshooting guide above
2. Review existing GitHub issues
3. Submit a new issue with:
   - System information
   - Error logs
   - Steps to reproduce

## Future Enhancements

1. **File Operations**
   - Enhanced streaming capabilities
   - Advanced compression options
   - Batch file processing
   - File type detection
   - Metadata management
   - Version control integration

2. **Media Processing**
   - Additional video formats
   - Advanced image processing
   - Audio enhancement tools
   - Real-time processing
   - Quality optimization
   - Format conversion

3. **Cloud Integration**
   - Multi-cloud support
   - Advanced caching
   - CDN optimization
   - Auto-scaling features
   - Cost optimization
   - Backup automation

4. **Speech Services**
   - Additional voice models
   - Language expansion
   - Emotion detection
   - Voice cloning
   - Real-time synthesis
   - Custom voice training

5. **Browser Automation**
   - Headless optimization
   - Parallel processing
   - Session management
   - Cookie handling
   - Proxy support
   - Resource optimization

6. **Security Features**
   - Enhanced encryption
   - Access control
   - Audit logging
   - Threat detection
   - Rate limiting
   - Compliance tools

7. **Performance Optimization**
   - Memory management
   - CPU utilization
   - Concurrent operations
   - Resource pooling
   - Cache strategies
   - Load balancing

8. **Developer Tools**
   - Enhanced debugging
   - Testing framework
   - Documentation generator
   - CLI improvements
   - Monitoring tools
   - Integration templates

We welcome community feedback and contributions to help prioritize these enhancements.

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [Node.js](https://nodejs.org/) - The core runtime environment
- [FFmpeg](https://ffmpeg.org/) - Media processing capabilities
- [ElevenLabs](https://elevenlabs.io/) - Voice synthesis
- [OpenAI](https://openai.com/) - Transcription and AI services
- [AWS S3](https://aws.amazon.com/s3/) - Cloud storage
- [Playwright](https://playwright.dev/) - Browser automation
- [LLaMA](https://github.com/facebookresearch/llama) - Local language models
- [VITS](https://github.com/jaywalnut310/vits) - Voice synthesis
- [Deepgram](https://deepgram.com/) - Speech recognition
- [Sharp](https://sharp.pixelplumbing.com/) - Image processing

Special thanks to:
- The Node.js community and all the open-source contributors who make these integrations possible.
- The Eliza community for their contributions and feedback.

For more information about Node.js capabilities:
- [Node.js Documentation](https://nodejs.org/en/docs/)
- [Node.js Developer Portal](https://nodejs.org/en/about/)
- [Node.js GitHub Repository](https://github.com/nodejs/node)

## License

This plugin is part of the Eliza project. See the main project repository for license information.