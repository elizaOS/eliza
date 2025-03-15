## ImageDescriptionService

Processes and analyzes images to generate descriptions. Supports multiple providers:

- Local processing using Florence model
- OpenAI Vision API
- Google Gemini

Configuration:

```env
# For OpenAI Vision
OPENAI_API_KEY=your_openai_api_key

# For Google Gemini
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key
```

Provider selection:

- If `imageVisionModelProvider` is set to `google/openai`, it will use this one.
- Else if `model` is set to `google/openai`, it will use this one.
- Default if nothing is set is OpenAI.

The service automatically handles different image formats, including GIFs (first frame extraction).

Features by provider:

**Local (Florence):**

- Basic image captioning
- Local processing without API calls

**OpenAI Vision:**

- Detailed image descriptions
- Text detection
- Object recognition

**Google Gemini 1.5:**

- High-quality image understanding
- Detailed descriptions with natural language
- Multi-modal context understanding
- Support for complex scenes and content

The provider can be configured through the runtime settings, allowing easy switching between providers based on your needs.

// ... existing code ...

### describeImage

Analyzes and generates descriptions for images.

```typescript
// Example usage
const result = await runtime.executeAction("DESCRIBE_IMAGE", {
    imageUrl: "path/to/image.jpg",
});
```