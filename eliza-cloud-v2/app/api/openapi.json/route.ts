/**
 * OpenAPI Specification Endpoint
 *
 * Returns the OpenAPI 3.1.0 specification for the Eliza Cloud API.
 * Referenced in ERC-8004 registration for service discovery.
 *
 * GET /api/openapi.json
 */

import { NextResponse } from "next/server";
import { discoverApiV1Routes } from "@/lib/docs/api-route-discovery";

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

function toOperationId(method: string, routePath: string) {
  // e.g. POST /api/v1/apps/{id}/earnings -> post_api_v1_apps_id_earnings
  const clean = routePath
    .replace(/^\//, "")
    .replace(/[{}]/g, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "")
    .replace(/[\/-]+/g, "_");
  return `${method.toLowerCase()}_${clean}`;
}

function tagForPath(routePath: string) {
  const parts = routePath.split("/").filter(Boolean);
  // ["api","v1",...]
  const group = parts[2] ?? "v1";
  return group === "v1" ? "v1" : group;
}

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";

  const discovered = await discoverApiV1Routes();
  const discoveredPaths: Record<string, OpenApiPathItem> = {};

  for (const r of discovered) {
    if (!discoveredPaths[r.path]) discoveredPaths[r.path] = {};
    const tag = tagForPath(r.path);

    for (const method of r.methods) {
      discoveredPaths[r.path][method.toLowerCase()] = {
        operationId: toOperationId(method, r.path),
        summary: r.meta?.name ?? `${method} ${r.path}`,
        description: r.meta?.description,
        tags: r.meta?.category ? [r.meta.category] : [tag],
        responses: {
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
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Eliza Cloud API",
      version: "1.0.0",
      description:
        "AI agent infrastructure API. Supports REST, MCP, and A2A protocols with API key authentication.",
      contact: {
        name: "Eliza Cloud",
        url: "https://elizacloud.ai",
      },
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    servers: [
      {
        url: baseUrl,
        description: "Production server",
      },
    ],
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    paths: {
      ...discoveredPaths,
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Privy session token",
        },
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
      url: "https://elizacloud.ai/docs",
    },
  };

  return NextResponse.json(spec, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
