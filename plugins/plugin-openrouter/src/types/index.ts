import type { LanguageModelUsage } from "ai";

export interface OpenRouterConfig {
  apiKey?: string;
  baseURL?: string;
  smallModel?: string;
  largeModel?: string;
  imageModel?: string;
}

export interface GenerateTextResponse {
  text: string;
  finishReason?: string;
  usage?: LanguageModelUsage;
}

export interface ImageDescriptionResult {
  title: string;
  description: string;
}

export interface OpenRouterImageResponse {
  choices?: Array<{
    message?: {
      images?: Array<{
        image_url: {
          url: string;
        };
      }>;
    };
  }>;
}
