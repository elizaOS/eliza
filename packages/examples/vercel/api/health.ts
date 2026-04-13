/**
 * Vercel Edge Function - Health Check Endpoint
 */

export const config = {
  runtime: "edge",
};

interface HealthResponse {
  status: "healthy" | "unhealthy";
  runtime: string;
  version: string;
}

export default function handler(_request: Request): Response {
  const response: HealthResponse = {
    status: "healthy",
    runtime: "elizaos-typescript",
    version: "1.0.0",
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
