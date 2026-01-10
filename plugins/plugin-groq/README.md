# Groq Plugin

This plugin provides integration with Groq Cloud through the ElizaOS platform.

## Usage

Add the plugin to your character configuration:

```json
"plugins": ["@elizaos-plugins/plugin-groq"]
```

## Configuration

The plugin requires these environment variables (can be set in .env file or character settings):

```json
"settings": {
  "GROQ_API_KEY": "your_groq_api_key",
  "GROQ_BASE_URL": "optional_custom_endpoint",
  "GROQ_SMALL_MODEL": "llama-3.1-8b-instant",
  "GROQ_LARGE_MODEL": "qwen-qwq-32b"
}
```

Or in `.env` file:

```
GROQ_API_KEY=your_groq_api_key
# Optional overrides:
GROQ_BASE_URL=optional_custom_endpoint
GROQ_SMALL_MODEL=llama-3.1-8b-instant
GROQ_LARGE_MODEL=qwen-qwq-32b
```

### Configuration Options

- `GROQ_API_KEY` (required): Your Groq API credentials.
- `GROQ_BASE_URL`: Custom API endpoint (default: https://api.groq.com/openai/v1).
- `GROQ_SMALL_MODEL`: Defaults to Llama 3.1 8B Instant ("llama-3.1-8b-instant").
- `GROQ_LARGE_MODEL`: Defaults to Qwen QWQ 32B ("qwen-qwq-32b").

The plugin provides these model classes:

- `TEXT_SMALL`: Optimized for fast, cost-effective responses (uses `GROQ_SMALL_MODEL`).
- `TEXT_LARGE`: For complex tasks requiring deeper reasoning (uses `GROQ_LARGE_MODEL`).
- `IMAGE`: Image generation.
- `TRANSCRIPTION`: Whisper audio transcription.
- `TEXT_TOKENIZER_ENCODE`: Text tokenization.
- `TEXT_TOKENIZER_DECODE`: Token decoding.
- `OBJECT_SMALL`: For generating structured JSON objects with the small model.
- `OBJECT_LARGE`: For generating structured JSON objects with the large model.

## Additional Features

### Text Generation (Small Model)

```javascript
const response = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: 'Explain quantum computing in simple terms.',
  // Optional parameters:
  // stopSequences: ["stop phrase"],
  // maxTokens: 200,
  // temperature: 0.7,
  // frequencyPenalty: 0.7,
  // presencePenalty: 0.7,
});
console.log(response);
```

### Text Generation (Large Model)

```javascript
const response = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: 'Write a comprehensive guide on sustainable gardening.',
  // Optional parameters:
  // stopSequences: ["stop phrase"],
  // maxTokens: 1000,
  // temperature: 0.8,
  // frequencyPenalty: 0.5,
  // presencePenalty: 0.5,
});
console.log(response);
```

### Image Generation

```javascript
const images = await runtime.useModel(ModelType.IMAGE, {
  prompt: 'A futuristic cityscape at sunset',
  n: 1, // number of images
  size: '1024x1024', // image resolution
});
console.log(images[0].url); // Example: Accessing the URL of the first image
```

### Audio Transcription

```javascript
// Assuming 'audioBuffer' is a Buffer containing the audio data (e.g., from a file)
const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
console.log(transcription);
```

### Text Tokenization (Encode)

```javascript
const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
  prompt: 'Hello, world!',
  modelType: ModelType.TEXT_SMALL, // Or ModelType.TEXT_LARGE
});
console.log(tokens);
```

### Text Tokenization (Decode)

```javascript
// Assuming 'tokens' is an array of numbers obtained from encoding
const text = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
  tokens: [15339, 29871, 29991], // Example tokens for "Hello, world!" with some models
  modelType: ModelType.TEXT_SMALL, // Or ModelType.TEXT_LARGE
});
console.log(text);
```

### Object Generation (Small Model)

```javascript
const userProfile = await runtime.useModel(ModelType.OBJECT_SMALL, {
  prompt: 'Generate a JSON object for a user with name "Alex", age 30, and hobbies ["reading", "hiking"].',
  temperature: 0.5,
});
console.log(userProfile);
```

### Object Generation (Large Model)

```javascript
const complexData = await runtime.useModel(ModelType.OBJECT_LARGE, {
  prompt: 'Generate a detailed JSON object for a product listing: name "Laptop Pro", category "Electronics", price 1200, features ["16GB RAM", "512GB SSD", "15-inch Display"], and availability "in stock".',
  temperature: 0.7,
});
console.log(complexData);
```
