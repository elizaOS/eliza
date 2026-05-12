/* eslint-disable */
/**
 * Stable local `api` utility types for TypeScript checks before Convex codegen
 * has run. `npx convex dev` regenerates the runtime files in this directory.
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as agent from "../agent.js";
import type * as http from "../http.js";
import type * as messages from "../messages.js";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  http: typeof http;
  messages: typeof messages;
}>;

type AnyFunctionType = "query" | "mutation" | "action";

export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<AnyFunctionType, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<AnyFunctionType, "internal">
>;
