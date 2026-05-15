/**
 * Shared Hono app for `/api/mcps/:provider/:transport`.
 *
 * - Built-in providers (`time`, `weather`, `crypto`) run a Workers-safe
 *   JSON-RPC MCP transport directly.
 * - OAuth / vendor MCPs proxy to an operator URL from `MCP_<PROVIDER>_STREAMABLE_HTTP_URL`
 *   (e.g. `MCP_GITHUB_STREAMABLE_HTTP_URL`).
 *
 * Lives under `apps/api/src` so Wrangler can resolve `hono` from the API package graph.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { forwardMcpUpstreamRequest } from "@/lib/mcp/mcp-upstream-forward";
import type { AppEnv } from "@/types/cloud-worker-env";

const BUILTIN = new Set<string>(["time", "weather", "crypto"]);
const COINGECKO = "https://api.coingecko.com/api/v3";

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

interface ToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

interface GeocodeItem {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly country?: string;
  readonly admin1?: string;
}

interface GeocodeResponse {
  readonly results?: GeocodeItem[];
}

interface ForecastResponse {
  readonly current_weather?: {
    readonly temperature?: number;
    readonly windspeed?: number;
    readonly winddirection?: number;
    readonly weathercode?: number;
    readonly time?: string;
  };
}

const TIMEZONE_ALIASES: Record<string, string> = {
  EST: "America/New_York",
  PST: "America/Los_Angeles",
  GMT: "Etc/GMT",
  UTC: "UTC",
  JST: "Asia/Tokyo",
};

const BUILTIN_TOOLS: Record<string, McpTool[]> = {
  time: [
    {
      name: "get_current_time",
      description: "Get the current date and time in various formats for any timezone.",
      inputSchema: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            default: "UTC",
            description: "IANA timezone or alias such as PST or JST",
          },
          format: {
            type: "string",
            enum: ["iso", "unix", "readable", "all"],
            default: "all",
          },
        },
        additionalProperties: false,
      },
    },
  ],
  weather: [
    {
      name: "get_current_weather",
      description: "Current weather for a place name or explicit latitude/longitude.",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string", description: "City or region name, e.g. Berlin" },
          latitude: { type: "number" },
          longitude: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "search_location",
      description: "Resolve a place name to coordinates using Open-Meteo geocoding.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Place name" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
  crypto: [
    {
      name: "get_price",
      description: "Current spot price for a CoinGecko coin id.",
      inputSchema: {
        type: "object",
        properties: {
          coin: { type: "string", description: "CoinGecko id, e.g. bitcoin" },
          currency: { type: "string", default: "usd" },
        },
        required: ["coin"],
        additionalProperties: false,
      },
    },
    {
      name: "get_market_data",
      description: "Market summary for a coin id.",
      inputSchema: {
        type: "object",
        properties: {
          coin: { type: "string", description: "CoinGecko id, e.g. ethereum" },
        },
        required: ["coin"],
        additionalProperties: false,
      },
    },
    {
      name: "list_trending",
      description: "Trending search coins on CoinGecko.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
};

function upstreamEnvKey(provider: string): string {
  const slug = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `MCP_${slug}_STREAMABLE_HTTP_URL`;
}

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function textResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function resolveTimezone(tz: string): string {
  const upper = tz.toUpperCase().replace(/[- ]/g, "_");
  return TIMEZONE_ALIASES[upper] ?? tz;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function geocode(query: string): Promise<GeocodeItem | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as GeocodeResponse;
  return data.results?.[0] ?? null;
}

async function callTimeTool(name: string, args: JsonObject): Promise<ToolResult> {
  if (name !== "get_current_time") {
    return errorResult({ error: `Unknown time tool: ${name}` });
  }
  const timezone = stringArg(args, "timezone") ?? "UTC";
  const format = stringArg(args, "format") ?? "all";
  const tz = resolveTimezone(timezone);
  if (!isValidTimezone(tz)) {
    return errorResult({ error: `Invalid timezone: ${timezone}` });
  }
  const now = new Date();
  const iso = now.toISOString();
  const unix = Math.floor(now.getTime() / 1000);
  const readable = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const payload =
    format === "iso"
      ? { iso }
      : format === "unix"
        ? { unix }
        : format === "readable"
          ? { readable, timezone: tz }
          : { iso, unix, readable, timezone: tz };
  return textResult(payload);
}

async function callWeatherTool(name: string, args: JsonObject): Promise<ToolResult> {
  if (name === "search_location") {
    const query = stringArg(args, "query")?.trim();
    if (!query) return errorResult({ error: "Provide query" });
    const hit = await geocode(query);
    if (!hit) return textResult({ results: [] });
    return textResult({
      results: [
        {
          name: hit.name,
          latitude: hit.latitude,
          longitude: hit.longitude,
          country: hit.country,
          region: hit.admin1,
        },
      ],
    });
  }

  if (name !== "get_current_weather") {
    return errorResult({ error: `Unknown weather tool: ${name}` });
  }

  let lat = numberArg(args, "latitude");
  let lon = numberArg(args, "longitude");
  let label = "";

  if (lat == null || lon == null) {
    const location = stringArg(args, "location")?.trim();
    if (!location) {
      return errorResult({ error: "Provide location or latitude+longitude" });
    }
    const hit = await geocode(location);
    if (!hit) {
      return errorResult({ error: `No results for: ${location}` });
    }
    lat = hit.latitude;
    lon = hit.longitude;
    label = `${hit.name}${hit.admin1 ? `, ${hit.admin1}` : ""}${hit.country ? ` (${hit.country})` : ""}`;
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(lat));
  forecastUrl.searchParams.set("longitude", String(lon));
  forecastUrl.searchParams.set("current_weather", "true");
  forecastUrl.searchParams.set("timezone", "auto");

  const res = await fetch(forecastUrl.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) return errorResult({ error: "Weather provider request failed" });
  const data = (await res.json()) as ForecastResponse;
  return textResult({
    location: label || undefined,
    latitude: lat,
    longitude: lon,
    current: data.current_weather ?? null,
  });
}

async function callCryptoTool(name: string, args: JsonObject): Promise<ToolResult> {
  if (name === "list_trending") {
    const res = await fetch(`${COINGECKO}/search/trending`, {
      headers: { Accept: "application/json", "User-Agent": "eliza-cloud-mcp/1.0" },
    });
    if (!res.ok) return errorResult({ error: "CoinGecko trending failed" });
    const data = (await res.json()) as {
      readonly coins?: {
        readonly item?: { readonly id?: string; readonly name?: string; readonly symbol?: string };
      }[];
    };
    return textResult({ trending: (data.coins ?? []).map((c) => c.item) });
  }

  const coin = stringArg(args, "coin")?.trim().toLowerCase();
  if (!coin) return errorResult({ error: "Provide coin" });

  if (name === "get_price") {
    const currency = stringArg(args, "currency")?.trim().toLowerCase() || "usd";
    const url = new URL(`${COINGECKO}/simple/price`);
    url.searchParams.set("ids", coin);
    url.searchParams.set("vs_currencies", currency);
    url.searchParams.set("include_24hr_change", "true");
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "eliza-cloud-mcp/1.0" },
    });
    if (!res.ok) return errorResult({ error: "CoinGecko request failed" });
    const data = (await res.json()) as Record<string, Record<string, number>>;
    return textResult(data[coin] ?? {});
  }

  if (name === "get_market_data") {
    const url = new URL(`${COINGECKO}/coins/${encodeURIComponent(coin)}`);
    url.searchParams.set("localization", "false");
    url.searchParams.set("tickers", "false");
    url.searchParams.set("market_data", "true");
    url.searchParams.set("community_data", "false");
    url.searchParams.set("developer_data", "false");
    url.searchParams.set("sparkline", "false");
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "eliza-cloud-mcp/1.0" },
    });
    if (!res.ok) return errorResult({ error: `CoinGecko error: ${res.status}` });
    const raw = (await res.json()) as {
      readonly id?: string;
      readonly market_data?: {
        readonly current_price?: Record<string, number>;
        readonly market_cap?: Record<string, number>;
        readonly total_volume?: Record<string, number>;
      };
    };
    return textResult({
      id: raw.id,
      current_price: raw.market_data?.current_price,
      market_cap: raw.market_data?.market_cap,
      total_volume: raw.market_data?.total_volume,
    });
  }

  return errorResult({ error: `Unknown crypto tool: ${name}` });
}

async function callBuiltinTool(
  provider: string,
  name: string,
  args: JsonObject,
): Promise<ToolResult> {
  if (provider === "time") return callTimeTool(name, args);
  if (provider === "weather") return callWeatherTool(name, args);
  if (provider === "crypto") return callCryptoTool(name, args);
  return errorResult({ error: `Unknown built-in provider: ${provider}` });
}

async function handleBuiltinJsonRpc(provider: string, req: Request): Promise<Response> {
  if (req.method === "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: JsonRpcRequest;
  try {
    const parsed = await req.json();
    body = isJsonObject(parsed) ? parsed : {};
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const id = jsonRpcId(body.id);
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(id, -32600, "Invalid Request");
  }

  if (body.method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `eliza-cloud-${provider}`, version: "2.0.0" },
    });
  }

  if (body.method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (body.method === "tools/list") {
    return jsonRpcResult(id, { tools: BUILTIN_TOOLS[provider] ?? [] });
  }

  if (body.method === "tools/call") {
    const params = isJsonObject(body.params) ? body.params : {};
    const name = stringArg(params, "name");
    const args = isJsonObject(params.arguments) ? params.arguments : {};
    if (!name) {
      return jsonRpcError(id, -32602, "Missing tool name");
    }
    const result = await callBuiltinTool(provider, name, args);
    return jsonRpcResult(id, result);
  }

  if (body.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  return jsonRpcError(id, -32601, "Method not found");
}

export function createMcpsTransportApp(provider: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.all("*", async (c: Context<AppEnv>) => {
    const transport = c.req.param("transport");
    if (transport !== "mcp" && transport !== "streamable-http") {
      return c.json(
        {
          success: false,
          error: "unsupported_transport",
          allowed: ["mcp", "streamable-http"],
        },
        404,
      );
    }

    const envKey = upstreamEnvKey(provider);
    const upstreamRaw = c.env[envKey];
    if (typeof upstreamRaw === "string" && upstreamRaw.trim().length > 0) {
      return forwardMcpUpstreamRequest(c.req.raw, upstreamRaw.trim());
    }

    if (!BUILTIN.has(provider)) {
      return c.json(
        {
          success: false,
          error: "not_yet_migrated",
          reason: `Set ${envKey} to an HTTPS streamable-http MCP URL, or use built-in time, weather, or crypto.`,
        },
        501,
      );
    }

    return handleBuiltinJsonRpc(provider, c.req.raw);
  });

  return app;
}
