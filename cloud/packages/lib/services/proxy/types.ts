import type { UserWithOrganization } from "@/db/repositories/users";
import type { ApiKey } from "@/db/schemas/api-keys";

export type AuthLevel = "session" | "sessionWithOrg" | "apiKey" | "apiKeyWithOrg";

export interface CacheConfig {
  maxTTL: number;
  hitCostMultiplier?: number;
  isMethodCacheable?: (method: string) => boolean;
  maxResponseSize?: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (request: Request) => string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonValue;
  method: string;
  params?: JsonValue;
}

export type JsonRpcBatchRequest = JsonRpcRequest[];

export type ProxyRequestBody =
  | JsonRpcRequest
  | JsonRpcBatchRequest
  | Record<string, unknown>
  | null;

export interface ServiceConfig {
  id: string;
  name: string;
  auth: AuthLevel;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  getCost: (body: ProxyRequestBody, searchParams: URLSearchParams) => Promise<number>;
}

export interface HandlerContext {
  body: ProxyRequestBody;
  auth: { user: UserWithOrganization; apiKey?: ApiKey };
  searchParams: URLSearchParams;
}

export interface HandlerResult {
  response: Response;
  actualCost?: number;
  usageMetadata?: Record<string, unknown>;
}

export type ServiceHandler = (ctx: HandlerContext) => Promise<HandlerResult>;
