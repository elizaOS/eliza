/**
 * OpenAPI Specification Endpoint
 *
 * Returns the OpenAPI 3.1.0 specification for the Eliza Cloud API.
 * Referenced in ERC-8004 registration for service discovery.
 *
 * GET /api/openapi.json
 */

import { Hono } from "hono";
import { API_ENDPOINTS } from "@/lib/swagger/endpoint-discovery";
import type { AppEnv } from "@/types/cloud-worker-env";

type OpenApiPathItem = Record<
  string,
  {
    operationId: string;
    summary: string;
    description?: string;
    tags?: string[];
    security?: Array<Record<string, string[]>>;
    requestBody?: unknown;
    parameters?: unknown[];
    responses: Record<string, unknown>;
  }
>;

function toOperationId(method: string, routePath: string): string {
  const clean = routePath
    .replace(/^\//, "")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "")
    .replace(/[/-]+/g, "_");
  return `${method.toLowerCase()}_${clean}`;
}

function tagForPath(routePath: string): string {
  const parts = routePath.split("/").filter(Boolean);
  const group = parts[2] ?? "v1";
  return group === "v1" ? "v1" : group;
}

function getOpenApiServerUrl(env: { NEXT_PUBLIC_APP_URL?: string }): string {
  const configuredUrl = env.NEXT_PUBLIC_APP_URL;
  return configuredUrl && /^https:\/\/www\.(dev\.)?elizacloud\.ai$/.test(configuredUrl)
    ? configuredUrl
    : "https://www.elizacloud.ai";
}

const app = new Hono<AppEnv>();

function createOpenApiResponse(env: { NEXT_PUBLIC_APP_URL?: string }): Response {
  const baseUrl = getOpenApiServerUrl(env);

  const discoveredPaths: Record<string, OpenApiPathItem> = {};

  for (const endpoint of API_ENDPOINTS) {
    if (!discoveredPaths[endpoint.path]) discoveredPaths[endpoint.path] = {};
    const tag = tagForPath(endpoint.path);

    discoveredPaths[endpoint.path][endpoint.method.toLowerCase()] = {
      operationId: toOperationId(endpoint.method, endpoint.path),
      summary: endpoint.name ?? `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description,
      tags: endpoint.category ? [endpoint.category] : [tag],
      security: endpoint.requiresAuth ? [{ bearerAuth: [] }, { apiKeyAuth: [] }] : [],
      responses:
        endpoint.responses.length > 0
          ? Object.fromEntries(
              endpoint.responses.map((response) => [
                String(response.statusCode),
                { description: response.description },
              ]),
            )
          : {
              "200": { description: "Successful response" },
              "400": { description: "Bad request" },
              "401": { description: "Unauthorized" },
              "403": { description: "Forbidden" },
              "404": { description: "Not found" },
              "429": { description: "Rate limited" },
              "500": { description: "Server error" },
            },
    };
  }

  for (const pathItem of Object.values(discoveredPaths)) {
    for (const operation of Object.values(pathItem)) {
      operation.responses = {
        "400": { description: "Bad request" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden" },
        "404": { description: "Not found" },
        "429": { description: "Rate limited" },
        "500": { description: "Server error" },
        ...operation.responses,
      };
    }
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Eliza Cloud API",
      version: "1.0.0",
      description:
        "AI agent infrastructure API. Supports REST, MCP, and A2A protocols with API key authentication.",
      contact: { name: "Eliza Cloud", url: "https://www.elizacloud.ai" },
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
    },
    servers: [{ url: baseUrl, description: "Production server" }],
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    paths: { ...discoveredPaths },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Steward session token" },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "API Key for programmatic access",
        },
      },
    },
    tags: [],
    externalDocs: {
      description: "Eliza Cloud Documentation",
      url: "https://www.elizacloud.ai/docs",
    },
  };

  return Response.json(spec, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

app.get("/", (c) => createOpenApiResponse(c.env));

export function GET(): Response {
  return createOpenApiResponse({});
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export default app;
