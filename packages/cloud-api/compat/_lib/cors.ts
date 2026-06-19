import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";

export function handleCompatCorsOptions(methods: string): Response {
  return handleCorsOptions(methods);
}

export function withCompatCors(response: Response, methods: string): Response {
  return applyCorsHeaders(response, methods);
}
