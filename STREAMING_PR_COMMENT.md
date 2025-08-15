# 🚀 Streaming Support for ElizaOS Core Runtime

## Overview
This PR introduces comprehensive streaming support to the ElizaOS core runtime, enabling real-time, token-by-token responses from language models. This is a significant enhancement that improves user experience through faster perceived response times and enables new use cases like real-time transcription and audio streaming.

## Key Changes

### 1. Core Runtime Enhancements (`packages/core`)

#### New Streaming Types and Interfaces
- **`ModelStream<T>`**: Type alias for `AsyncIterable<T>` representing streaming data
- **`ModelStreamHandler`**: Interface for registering streaming model implementations
- **Stream Chunk Types**: 
  - `TextStreamChunk`: For text generation streaming (delta events with partial text)
  - `TranscriptionStreamChunk`: For audio transcription streaming (partial transcripts)
  - `TextToSpeechStreamChunk`: For TTS streaming (audio chunks)
  - Base types: `ModelStreamFinishChunk`, `ModelStreamErrorChunk`, `ModelStreamUsageChunk`

#### Runtime Implementation
- **Stream Registry**: New `streamModels` Map to store streaming handlers by model type
- **`registerModelStream()`**: Register streaming handlers with priority-based resolution
- **`getModelStream()`**: Retrieve the highest-priority streaming handler for a model type
- **Stream Normalization**: `wrapReadableStream()` utility that normalizes different stream types:
  - Native `AsyncIterable` objects
  - Web `ReadableStream` API
  - Node.js `Readable` streams

#### Unified `useModel` API
Instead of adding a separate `useModelStream` function, streaming is elegantly integrated into the existing `useModel` API through overloads:

```typescript
// Non-streaming (default)
const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "Hello" });

// Streaming via event parameter
const stream = await runtime.useModel(
  ModelType.TEXT_LARGE, 
  { prompt: "Hello" },
  'STREAMING_TEXT'
);

for await (const chunk of stream) {
  if (chunk.event === 'delta') {
    console.log(chunk.delta); // Partial text
  }
}
```

### 2. OpenAI Plugin Integration (`plugin-openai`)

#### Streaming Implementations
- **Text Generation**: Uses `@ai-sdk/openai`'s `streamText` for GPT models
  - Yields delta chunks with partial text
  - Includes usage statistics (token counts)
  - Proper finish events with complete output
  
- **Text-to-Speech**: Streaming audio generation
  - Yields audio chunks for real-time playback
  - Fallback to single chunk if response isn't streamable

#### Type Safety
- All streaming handlers are fully typed with no `any` casts
- Local type definitions to handle module resolution
- Conditional registration based on runtime capabilities

### 3. Testing Infrastructure

#### Core Streaming Tests (`packages/core/src/__tests__/streaming.test.ts`)
- Tests for streaming handler registration and priority resolution
- Fallback behavior when no streaming handler exists
- Event emission during streaming
- Proper async iteration over stream chunks

### 4. Type Safety Improvements

#### Complete Type Coverage
- **No more `any` types**: All parameters and returns are properly typed
- **Generic constraints**: Using TypeScript generics to maintain type relationships
- **Mapped types**: `ModelParamsMap`, `ModelResultMap`, `ModelStreamChunkMap` for type-safe model operations
- **Overloaded signatures**: Clean API with proper return type inference

#### Fixed Issues
- Tokenizer parameters now include required `modelType` field
- Proper type assertions only where necessary (stream type detection)
- All explicit casts removed in favor of proper typing

## Benefits

### For Users
- **Faster Time-to-First-Token**: Users see responses begin immediately
- **Better UX**: Progressive loading instead of waiting for complete responses
- **Real-time Features**: Enables live transcription, streaming audio, etc.

### For Developers
- **Simple API**: Streaming integrated into existing `useModel` function
- **Type Safety**: Full TypeScript support with no `any` types
- **Flexibility**: Support for different stream formats and sources
- **Extensibility**: Easy to add new streaming model types

## Technical Highlights

### Stream Event Types
```typescript
// Text streaming example
{ event: 'delta', delta: 'Hello' }
{ event: 'delta', delta: ' world' }
{ event: 'usage', tokens: { prompt: 5, completion: 2, total: 7 } }
{ event: 'finish', output: 'Hello world' }
```

### Error Handling
- Graceful fallback to non-streaming when handlers unavailable
- Proper error propagation through stream chunks
- Abort signal support for cancellation

### Performance
- Minimal overhead for non-streaming calls
- Efficient stream normalization without buffering
- Priority-based handler selection for optimal provider choice

## Breaking Changes
None! The implementation is fully backward compatible:
- Existing `useModel` calls work unchanged
- Streaming is opt-in via the event parameter
- Plugins without streaming support continue to work

## Migration Guide
To enable streaming in your code:

```typescript
// Before (still works)
const response = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Write a story"
});

// After (with streaming)
const stream = await runtime.useModel(
  ModelType.TEXT_LARGE,
  { prompt: "Write a story" },
  'STREAMING_TEXT'
);

for await (const chunk of stream) {
  if (chunk.event === 'delta') {
    process.stdout.write(chunk.delta);
  }
}
```

## Testing
- ✅ All existing tests pass
- ✅ New streaming-specific tests added
- ✅ Type checking passes with no errors
- ✅ No regression in non-streaming functionality

## Future Enhancements
- WebSocket/SSE transport for browser clients
- Streaming support for more model types (embeddings, image generation)
- Stream transformation utilities (buffering, throttling)
- Progress indicators for long-running streams

---

This implementation provides a robust, type-safe foundation for streaming in ElizaOS while maintaining full backward compatibility and excellent developer experience.
