import type { ModelStream, TextStreamChunk, TranscriptionStreamChunk } from '@elizaos/core';

/**
 * Utility function to handle both string and stream responses from useModel
 * @param response - The response from useModel which can be either a string or a ModelStream
 * @returns The accumulated text from the response
 */
export async function handleModelResponse(
  response: string | ModelStream<TextStreamChunk>
): Promise<string> {
  // If it's already a string, return it directly
  if (typeof response === 'string') {
    return response;
  }

  // If it's a stream, consume it to get the full text
  let accumulated = '';
  for await (const chunk of response) {
    if ('delta' in chunk && chunk.event === 'delta') {
      accumulated += chunk.delta;
    } else if ('output' in chunk && chunk.event === 'finish') {
      accumulated = chunk.output;
    }
  }
  return accumulated;
}

/**
 * Utility function to handle both string and stream responses from transcription models
 * @param response - The response from useModel which can be either a string or a ModelStream
 * @returns The accumulated text from the response
 */
export async function handleTranscriptionResponse(
  response: string | ModelStream<TranscriptionStreamChunk>
): Promise<string> {
  // If it's already a string, return it directly
  if (typeof response === 'string') {
    return response;
  }

  // If it's a stream, consume it to get the full text
  let accumulated = '';
  for await (const chunk of response) {
    if ('text' in chunk && chunk.event === 'partial') {
      accumulated = chunk.text; // For transcription, partials replace rather than append
    } else if ('output' in chunk && chunk.event === 'finish') {
      accumulated = chunk.output;
    }
  }
  return accumulated;
}

/**
 * Type guard to check if a response is a stream
 */
export function isStream<T>(response: string | ModelStream<T>): response is ModelStream<T> {
  return typeof response !== 'string';
}
