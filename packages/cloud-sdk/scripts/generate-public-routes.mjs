#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  extractMethods,
  findCloudApiRoot,
  isGeneratedPublicRoute,
  segmentToRouteParam,
  walkRoutes,
} from "./route-discovery.mjs";

function pascalCase(value) {
  const words = value
    .replace(/^\{(.+)\}$/, "by-$1")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

function methodNameFor(method, route, usedNames) {
  const base = method.toLowerCase() + route.split("/").filter(Boolean).map(pascalCase).join("");

  const existingRoute = usedNames.get(base);
  if (existingRoute) {
    throw new Error(
      `Generated method name collision for ${method} ${route}: ${base} already maps to ${existingRoute}`,
    );
  }
  usedNames.set(base, `${method} ${route}`);
  return base;
}

function quote(value) {
  return JSON.stringify(value);
}

function endpointLine(endpoint) {
  const pathParams = `[${endpoint.pathParams.map(quote).join(", ")}]`;
  const catchAllPathParams = `[${endpoint.catchAllPathParams.map(quote).join(", ")}]`;
  return `  ${quote(endpoint.key)}: { method: ${quote(endpoint.method)}, path: ${quote(
    endpoint.route,
  )}, methodName: ${quote(endpoint.methodName)}, responseMode: ${quote(
    endpoint.responseMode,
  )}, pathParams: ${pathParams}, catchAllPathParams: ${catchAllPathParams}, file: ${quote(
    endpoint.file,
  )} },`;
}

function pathParamTypeLine(endpoint) {
  if (endpoint.pathParams.length === 0) {
    return `  ${quote(endpoint.key)}: Record<never, never>;`;
  }
  const catchAllPathParams = new Set(endpoint.catchAllPathParams);
  const fields = endpoint.pathParams
    .map((param) => {
      const valueType = catchAllPathParams.has(param)
        ? "string | number | readonly (string | number)[]"
        : "string | number";
      return `${quote(param)}: ${valueType}`;
    })
    .join("; ");
  return `  ${quote(endpoint.key)}: { ${fields} };`;
}

function responseModeFor(method, route, source) {
  if (route.endsWith("/tts")) return "binary";
  if (source.includes('"Content-Type": "text/html')) return "text";
  if (route.includes("/stream") || route.endsWith("/logs/stream")) return "stream";
  if (route.endsWith("/terminal") && method === "GET") return "stream";
  if (source.includes("text/event-stream") || source.includes("SSE_HEADERS")) return "mixed";
  return "json";
}

function routeMethod(endpoint) {
  const optionsArg =
    endpoint.pathParams.length > 0
      ? `options: PublicRouteCallOptions<${quote(endpoint.key)}>`
      : `options: PublicRouteCallOptions<${quote(endpoint.key)}> = {}`;
  if (
    endpoint.responseMode === "binary" ||
    endpoint.responseMode === "stream" ||
    endpoint.responseMode === "text"
  ) {
    return [
      `  ${endpoint.methodName}(`,
      `    ${optionsArg}`,
      "  ): Promise<Response> {",
      `    return this.callRaw(${quote(endpoint.key)}, options);`,
      "  }",
    ].join("\n");
  }
  return [
    `  ${endpoint.methodName}<TResponse = unknown>(`,
    `    ${optionsArg}`,
    "  ): Promise<TResponse> {",
    `    return this.call<${quote(endpoint.key)}, TResponse>(${quote(endpoint.key)}, options);`,
    "  }",
  ].join("\n");
}

function routeRawMethod(endpoint) {
  const optionsArg =
    endpoint.pathParams.length > 0
      ? `options: PublicRouteCallOptions<${quote(endpoint.key)}>`
      : `options: PublicRouteCallOptions<${quote(endpoint.key)}> = {}`;
  return [
    `  ${endpoint.methodName}Raw(${optionsArg}): Promise<Response> {`,
    `    return this.callRaw(${quote(endpoint.key)}, options);`,
    "  }",
  ].join("\n");
}

const { cloudRoot, apiRoot } = await findCloudApiRoot(process.cwd());
const routeFiles = await walkRoutes(apiRoot);
const usedNames = new Map();
const endpoints = [];

for (const routeFile of routeFiles) {
  const source = await readFile(routeFile.fullPath, "utf8");
  const methods = (await extractMethods(source, routeFile.fullPath, cloudRoot)).filter(
    (method) => method !== "OPTIONS" && method !== "HEAD",
  );
  if (methods.length === 0) continue;

  const segments = routeFile.relativeSegments.map(segmentToRouteParam);
  const route = `/api/${segments.map((segment) => segment.routeSegment).join("/")}`;
  if (!isGeneratedPublicRoute(route)) continue;

  const pathParams = segments.flatMap((segment) => (segment.paramName ? [segment.paramName] : []));
  const catchAllPathParams = segments.flatMap((segment) =>
    segment.paramName && segment.catchAll ? [segment.paramName] : [],
  );
  const file = path.relative(cloudRoot, routeFile.fullPath);

  for (const method of methods) {
    const methodName = methodNameFor(method, route, usedNames);
    endpoints.push({
      key: `${method} ${route}`,
      method,
      route,
      methodName,
      responseMode: responseModeFor(method, route, source),
      pathParams,
      catchAllPathParams,
      file,
    });
  }
}

endpoints.sort((a, b) => a.key.localeCompare(b.key));

const source = `/* eslint-disable @typescript-eslint/no-explicit-any */
// Generated by scripts/generate-public-routes.mjs from public apps/api route modules.
// The exported PublicRoute* names are retained for backward compatibility.
// Do not edit by hand.

import type { CloudRequestOptions, HttpMethod } from "./types.js";

export const ELIZA_CLOUD_PUBLIC_ENDPOINTS = {
${endpoints.map(endpointLine).join("\n")}
} as const;

export type PublicRouteKey = keyof typeof ELIZA_CLOUD_PUBLIC_ENDPOINTS;

export type PublicRouteMethodName =
  (typeof ELIZA_CLOUD_PUBLIC_ENDPOINTS)[PublicRouteKey]["methodName"];

export type PublicRouteDefinition =
  (typeof ELIZA_CLOUD_PUBLIC_ENDPOINTS)[PublicRouteKey];

export type PublicRouteResponseMode = PublicRouteDefinition["responseMode"];

export type PublicRouteKeysWithoutPathParams = {
  [TKey in PublicRouteKey]: keyof PublicRoutePathParams[TKey] extends never ? TKey : never;
}[PublicRouteKey];

export type PublicRouteKeysWithPathParams = Exclude<
  PublicRouteKey,
  PublicRouteKeysWithoutPathParams
>;

export interface PublicRoutePathParams {
${endpoints.map(pathParamTypeLine).join("\n")}
}

export interface PublicRouteBaseCallOptions extends Omit<CloudRequestOptions, "json"> {
  json?: unknown;
}

export type PublicRouteCallOptions<TKey extends PublicRouteKey> =
  PublicRouteBaseCallOptions &
    (keyof PublicRoutePathParams[TKey] extends never
      ? { pathParams?: never }
      : { pathParams: PublicRoutePathParams[TKey] });

interface ElizaCloudPublicRouteTransport {
  request<TResponse>(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions
  ): Promise<TResponse>;
  requestRaw(method: HttpMethod, path: string, options?: CloudRequestOptions): Promise<Response>;
}

type PathParamValue = string | number | readonly (string | number)[];

function encodePathValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

function isPathParamArray(value: PathParamValue): value is readonly (string | number)[] {
  return Array.isArray(value);
}

function encodeCatchAllPathValue(value: PathParamValue): string {
  const parts = isPathParamArray(value) ? value : String(value).split("/");
  return parts
    .map(String)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildPublicRoutePath<TKey extends PublicRouteKey>(
  key: TKey,
  options: PublicRouteCallOptions<TKey> | undefined
): string {
  const endpoint = ELIZA_CLOUD_PUBLIC_ENDPOINTS[key];
  const pathParams = (options?.pathParams ?? {}) as Record<string, PathParamValue>;
  const expectedPathParams = new Set<string>(endpoint.pathParams);
  const catchAllPathParams = new Set<string>(endpoint.catchAllPathParams);

  for (const providedParamName of Object.keys(pathParams)) {
    if (!expectedPathParams.has(providedParamName)) {
      throw new Error(\`Unexpected path parameter "\${providedParamName}" for \${key}\`);
    }
  }

  return endpoint.path.replace(/\\{([^}]+)\\}/g, (_match, paramName: string) => {
    const value = pathParams[paramName];
    if (value === undefined) {
      throw new Error(\`Missing path parameter "\${paramName}" for \${key}\`);
    }
    if (catchAllPathParams.has(paramName)) {
      return encodeCatchAllPathValue(value);
    }
    if (isPathParamArray(value)) {
      throw new Error(\`Path parameter "\${paramName}" for \${key} does not accept multiple segments\`);
    }
    return encodePathValue(value);
  });
}

function toRequestOptions<TKey extends PublicRouteKey>(
  options: PublicRouteCallOptions<TKey> | undefined
): CloudRequestOptions {
  const { pathParams: _pathParams, ...requestOptions } = options ?? {};
  return requestOptions;
}

export class ElizaCloudPublicRoutesClient {
  constructor(private readonly client: ElizaCloudPublicRouteTransport) {}

  call<TKey extends PublicRouteKeysWithoutPathParams, TResponse = unknown>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>
  ): Promise<TResponse>;
  call<TKey extends PublicRouteKeysWithPathParams, TResponse = unknown>(
    key: TKey,
    options: PublicRouteCallOptions<TKey>
  ): Promise<TResponse>;
  call<TKey extends PublicRouteKey, TResponse = unknown>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>
  ): Promise<TResponse> {
    const endpoint = ELIZA_CLOUD_PUBLIC_ENDPOINTS[key];
    return this.client.request<TResponse>(
      endpoint.method as HttpMethod,
      buildPublicRoutePath(key, options),
      toRequestOptions(options)
    );
  }

  callRaw<TKey extends PublicRouteKeysWithoutPathParams>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>
  ): Promise<Response>;
  callRaw<TKey extends PublicRouteKeysWithPathParams>(
    key: TKey,
    options: PublicRouteCallOptions<TKey>
  ): Promise<Response>;
  callRaw<TKey extends PublicRouteKey>(
    key: TKey,
    options?: PublicRouteCallOptions<TKey>
  ): Promise<Response> {
    const endpoint = ELIZA_CLOUD_PUBLIC_ENDPOINTS[key];
    return this.client.requestRaw(
      endpoint.method as HttpMethod,
      buildPublicRoutePath(key, options),
      toRequestOptions(options)
    );
  }

${endpoints.map(routeMethod).join("\n\n")}

${endpoints.map(routeRawMethod).join("\n\n")}
}
`;

const outputPath = path.join(cloudRoot, "packages", "sdk", "src", "public-routes.ts");
const relativeOutputPath = path.relative(cloudRoot, outputPath);

if (process.argv.includes("--check")) {
  const currentSource = await readFile(outputPath, "utf8").catch(() => "");
  if (currentSource !== source) {
    console.error(
      `${relativeOutputPath} is stale. Run \`bun run generate:routes\` from packages/sdk.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`${relativeOutputPath} is up to date (${endpoints.length} endpoints)`);
  }
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source);
  console.log(`Generated ${relativeOutputPath} (${endpoints.length} endpoints)`);
}
