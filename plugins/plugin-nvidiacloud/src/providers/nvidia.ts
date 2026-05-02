import { createOpenAI } from '@ai-sdk/openai';
import type { IAgentRuntime } from '@elizaos/core';
import { getApiKey, getBaseURL } from '../utils/config';

export function createNvidiaOpenAI(runtime: IAgentRuntime) {
  const apiKey = getApiKey(runtime);
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY (or NVIDIA_CLOUD_API_KEY) is not set');
  }
  return createOpenAI({
    baseURL: getBaseURL(runtime),
    apiKey,
  });
}
