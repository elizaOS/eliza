/**
 * Type definitions for elizaOS Supabase Edge Function
 */

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

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
