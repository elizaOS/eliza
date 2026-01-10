# @elizaos/plugin-google-genai

Google Generative AI (Gemini) integration for ElizaOS.

## Installation

```bash
npm install @elizaos/plugin-google-genai
```

## Configuration

1. Get your Google AI API key from [Google AI Studio](https://aistudio.google.com/)
2. Set the API key in your environment:

```bash
GOOGLE_GENERATIVE_AI_API_KEY=your_api_key_here
```

## Usage

Add the plugin to your character configuration:

```json
{
  "plugins": ["@elizaos/plugin-google-genai"]
}
```

## Supported Models

- **Text Generation**:
  - Small: `gemini-2.0-flash-001` (default)
  - Large: `gemini-2.0-flash-001` (default)
- **Text Embeddings**: `text-embedding-004` (default)
- **Image Analysis**: `gemini-2.0-flash-001` (default)

## Environment Variables

- `GOOGLE_GENERATIVE_AI_API_KEY` (required): Your Google AI API key
- `GOOGLE_SMALL_MODEL` (optional): Override small model
- `GOOGLE_LARGE_MODEL` (optional): Override large model
- `GOOGLE_IMAGE_MODEL` (optional): Override image model
- `GOOGLE_EMBEDDING_MODEL` (optional): Override embedding model
- `SMALL_MODEL` (optional): Fallback for small model
- `LARGE_MODEL` (optional): Fallback for large model
- `IMAGE_MODEL` (optional): Fallback for image model

## Model Types Provided

- `TEXT_SMALL` - Fast text generation using Gemini Flash
- `TEXT_LARGE` - Complex text generation using Gemini
- `TEXT_EMBEDDING` - Text embeddings for similarity search
- `OBJECT_SMALL` - JSON object generation (small model)
- `OBJECT_LARGE` - Complex JSON object generation (large model)
- `IMAGE_DESCRIPTION` - Image analysis and description

## Features

- Direct integration with Google's Gemini models
- Support for text generation, embeddings, and image analysis
- Configurable safety settings
- Token usage tracking and event emission
- Automatic JSON parsing for object generation
- System instruction support from character configuration
