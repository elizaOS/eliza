/**
 * Type definitions for elizaOS Supabase Edge Function
 * Matches the AWS Lambda handler types for consistency
 */

// Request/Response types
export interface ChatRequest {
  message: string;
  userId?: string;
  conversationId?: string;
}

export interface ChatResponse {
  response: string;
  conversationId: string;
  timestamp: string;
}

export interface HealthResponse {
  status: "healthy" | "unhealthy" | "initializing";
  runtime: string;
  version: string;
}

export interface ErrorResponse {
  error: string;
  code: string;
}

// Character configuration
export interface Character {
  name: string;
  bio: string;
  system: string;
}

// Runtime types
export type UUID = string;

export interface Content {
  text?: string;
  attachments?: Array<{
    type: string;
    url?: string;
    data?: string;
  }>;
}

export interface Memory {
  id?: UUID;
  roomId: UUID;
  entityId: UUID;
  agentId: UUID;
  content: Content;
  createdAt?: number;
}

// OpenAI API types
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// CORS headers for edge function responses
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

