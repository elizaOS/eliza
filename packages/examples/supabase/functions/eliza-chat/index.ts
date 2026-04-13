/**
 * Supabase Edge Function handler for elizaOS chat worker
 *
 * This Edge Function processes chat messages and returns AI responses
 * using the elizaOS runtime with OpenAI as the LLM provider.
 *
 * This is identical to the AWS Lambda handler pattern but adapted for
 * Supabase Edge Functions (Deno runtime).
 */

import { errorResponse, handleChat, handleHealth } from "./lib/runtime.ts";


/**
 * Main Edge Function handler
 */
Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  console.log(`[elizaOS] ${method} ${path}`);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Health check endpoint
  // Matches: /eliza-chat/health, /functions/v1/eliza-chat/health, or just /health
  if (path.endsWith("/health") && method === "GET") {
    return handleHealth();
  }

  // Root health check (GET /)
  if ((path === "/" || path.endsWith("/eliza-chat")) && method === "GET") {
    return handleHealth();
  }

  // Chat endpoint (POST to root or /chat)
  if (method === "POST") {
    return await handleChat(req);
  }

  // Method not allowed
  return errorResponse(
    `Method ${method} not allowed`,
    405,
    "METHOD_NOT_ALLOWED",
  );
});
