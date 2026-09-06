#!/usr/bin/env node

/**
 * Regenerates the public route facade and descriptor/type/client modules from the Cloud API route tree — the sole
 * writer of those generated files, which must never be hand-edited. Discovers
 * public routes via route-discovery.mjs and emits typed wrappers plus the
 * `ELIZA_CLOUD_PUBLIC_ENDPOINTS` descriptor map.
 */

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PUBLIC_ROUTE_GENERATED_HEADER,
  reconcilePublicRouteOutputs,
} from "./public-route-outputs.mjs";
import {
  canonicalRouteMethods,
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
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function methodNameFor(method, route, usedNames) {
  const base =
    method.toLowerCase() +
    route.split("/").filter(Boolean).map(pascalCase).join("");

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

const JSON_OR_EMPTY_ROUTES = new Set([
  "DELETE /api/v1/apis/storage/objects/_",
  "GET /api/v1/advertising/conversions/track",
  "GET /api/v1/marketing/inventory/serve",
  "GET /api/v1/remote/sessions/{id}/commands",
  "POST /api/v1/twilio/voice/status",
]);

function responseModeFor(method, route, source) {
  if (
    route === "/api/v1/apis/storage/objects/_" &&
    (method === "GET" || method === "HEAD")
  )
    return "binary";
  if (route.endsWith("/tts")) return "binary";
  if (
    method === "GET" &&
    route === "/api/v1/apps/{id}/frontend/preview/{[...path]}"
  )
    return "binary";
  if (method === "GET" && route === "/api/v1/hosted-frontend/serve/{[...path]}")
    return "binary";
  if (source.includes('"Content-Type": "text/html')) return "text";
  if (/\bc\.text\s*\(/.test(source)) return "text";
  if (route.includes("/stream") || route.endsWith("/logs/stream"))
    return "stream";
  if (route.endsWith("/terminal") && method === "GET") return "stream";
  if (source.includes("text/event-stream") || source.includes("SSE_HEADERS"))
    return "mixed";
  if (method === "HEAD" || JSON_OR_EMPTY_ROUTES.has(`${method} ${route}`))
    return "json-or-empty";
  return "json";
}

function headerTypeLine(endpoint) {
  if (endpoint.route === "/api/v1/apis/storage/objects/_") {
    const integrityHeader =
      endpoint.method === "PUT"
        ? ` "X-Content-Length": string; "X-Content-SHA256": string;`
        : "";
    return `  ${quote(endpoint.key)}: { "X-Storage-Object-Key": string; "Idempotency-Key": string;${integrityHeader} "Content-Type"?: string };`;
  }
  if (endpoint.route === "/api/v1/apis/storage/presign") {
    return `  ${quote(endpoint.key)}: { "X-Storage-Object-Key": string; "Idempotency-Key": string; "Content-Type"?: string };`;
  }
  if (endpoint.route === "/api/v1/apis/storage/list") {
    return `  ${quote(endpoint.key)}: { "X-Storage-Prefix": string; "X-Storage-Recursive": "true" | "false"; "Idempotency-Key": string };`;
  }
  return `  ${quote(endpoint.key)}: never;`;
}

function requiresStorageHeaders(endpoint) {
  return (
    endpoint.route === "/api/v1/apis/storage/objects/_" ||
    endpoint.route === "/api/v1/apis/storage/presign" ||
    endpoint.route === "/api/v1/apis/storage/list"
  );
}

function routeMethod(endpoint) {
  const optionsArg =
    endpoint.pathParams.length > 0 || requiresStorageHeaders(endpoint)
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
  if (endpoint.responseMode === "json-or-empty") {
    return [
      `  ${endpoint.methodName}<TResponse = unknown>(`,
      `    ${optionsArg}`,
      "  ): Promise<CloudResponse<TResponse>> {",
      `    return this.callBodyless<${quote(endpoint.key)}, TResponse>(${quote(endpoint.key)}, options);`,
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
    endpoint.pathParams.length > 0 || requiresStorageHeaders(endpoint)
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
  const canonical = await canonicalRouteMethods(
    source,
    routeFile.fullPath,
    cloudRoot,
    routeFile.relativeSegments,
  );
  if (!canonical) continue;
  const { route, methods, fixedStorageObject } = canonical;
  if (!isGeneratedPublicRoute(route)) continue;

  const segments = routeFile.relativeSegments.map(segmentToRouteParam);
  const pathParams = fixedStorageObject
    ? []
    : segments.flatMap((segment) =>
        segment.paramName ? [segment.paramName] : [],
      );
  const catchAllPathParams = fixedStorageObject
    ? []
    : segments.flatMap((segment) =>
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

const generatedHeader = PUBLIC_ROUTE_GENERATED_HEADER;
const outputs = new Map([
  [
    "public-routes.ts",
    `/** Preserves the public route client and correlated endpoint types at the established SDK path. */

export { ElizaCloudPublicRoutesClient } from "./public-routes/client.generated.js";
export { ELIZA_CLOUD_PUBLIC_ENDPOINTS } from "./public-routes/descriptors.generated.js";
export type * from "./public-routes/types.generated.js";
`,
  ],
  [
    "public-routes/descriptors.generated.ts",
    `${generatedHeader}
export const ELIZA_CLOUD_PUBLIC_ENDPOINTS = {
${endpoints.map(endpointLine).join("\n")}
} as const;
`,
  ],
  [
    "public-routes/types.generated.ts",
    `${generatedHeader}
import type { CloudRequestOptions } from "../types.js";
import type { ELIZA_CLOUD_PUBLIC_ENDPOINTS } from "./descriptors.generated.js";
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

export interface PublicRouteHeaders {
${endpoints.map(headerTypeLine).join("\n")}
}

export interface PublicRouteBaseCallOptions extends Omit<CloudRequestOptions, "json"> {
  json?: unknown;
}

export type PublicRouteCallOptions<TKey extends PublicRouteKey> =
  (PublicRouteHeaders[TKey] extends never
    ? PublicRouteBaseCallOptions
    : Omit<PublicRouteBaseCallOptions, "headers"> & { headers: PublicRouteHeaders[TKey] }) &
    (keyof PublicRoutePathParams[TKey] extends never
      ? { pathParams?: never }
      : { pathParams: PublicRoutePathParams[TKey] });
`,
  ],
  [
    "public-routes/client.generated.ts",
    `${generatedHeader}
import type { CloudResponse } from "../types.js";
import { PublicRouteTransport } from "./transport.js";
import type { PublicRouteCallOptions } from "./types.generated.js";

export class ElizaCloudPublicRoutesClient extends PublicRouteTransport {
${endpoints.map(routeMethod).join("\n\n")}

${endpoints.map(routeRawMethod).join("\n\n")}
}
`,
  ],
]);

async function firstExistingPath(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return paths[0];
}

const entryPath = await firstExistingPath([
  path.join(cloudRoot, "packages", "cloud", "sdk", "src", "public-routes.ts"),
  path.join(cloudRoot, "packages", "sdk", "src", "public-routes.ts"),
]);
const biomeBin = path.join(
  cloudRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);
// All outputs are formatted before any file is written, so formatter failure
// cannot leave a partially regenerated contract set.
const formattedOutputs = [...outputs].map(([relativePath, source]) => {
  const outputPath = path.join(path.dirname(entryPath), relativePath);
  const result = spawnSync(
    biomeBin,
    ["format", "--stdin-file-path", outputPath],
    {
      input: source,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to format ${relativePath}: ${result.stderr}`);
  }
  return { relativePath, source: result.stdout };
});

const stale = await reconcilePublicRouteOutputs(
  path.dirname(entryPath),
  formattedOutputs,
  {
    check: process.argv.includes("--check"),
  },
);
if (process.argv.includes("--check") && stale.length > 0) {
  console.error(
    `Public route outputs are stale or orphaned: ${stale.join(", ")}. Run the public route generator.`,
  );
  process.exitCode = 1;
}

console.log(
  `Public routes: ${endpoints.length} endpoints across ${formattedOutputs.length} generated outputs`,
);
