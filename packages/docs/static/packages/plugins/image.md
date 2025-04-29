# ImageDescriptionService

## Purpose

Processes and analyzes images to generate descriptions.

## Key Features

- Local processing using Florence model
- OpenAI Vision API integration
- Google Gemini support
- Automatic handling of different image formats, including GIFs
- Provider-specific capabilities (basic captioning, text detection, object recognition, etc.)

## Configuration

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

## Example Usage

```typescript
const result = await runtime.executeAction('DESCRIBE_IMAGE', {
  imageUrl: 'path/to/image.jpg',
});
```
