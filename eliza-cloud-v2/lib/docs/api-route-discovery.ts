import fs from "node:fs/promises";
import path from "node:path";

import {
  API_ENDPOINTS,
  type ApiEndpoint,
} from "@/lib/swagger/endpoint-discovery";

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

export interface DiscoveredApiRoute {
  path: string;
  methods: HttpMethod[];
  /**
   * Absolute, normalized file path (useful for debugging)
   */
  filePath: string;
  /**
   * Best-effort metadata sourced from the internal endpoint catalog when available.
   */
  meta?: Pick<
    ApiEndpoint,
    | "id"
    | "name"
    | "description"
    | "category"
    | "requiresAuth"
    | "pricing"
    | "rateLimit"
    | "tags"
  >;
}

const METHOD_RE =
  /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;

function segmentToOpenApi(segment: string): string {
  // Dynamic route: [id] -> {id}
  if (segment.startsWith("[") && segment.endsWith("]")) {
    const inner = segment.slice(1, -1);
    // Catch-all: [...slug] -> {slug}
    const name = inner.startsWith("...") ? inner.slice(3) : inner;
    return `{${name}}`;
  }
  return segment;
}

async function walkRoutes(
  dir: string,
  relativeSegments: string[],
  out: Array<{ filePath: string; segments: string[] }>,
) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;

    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkRoutes(full, [...relativeSegments, ent.name], out);
      continue;
    }

    // Next route handler file
    if (ent.isFile() && (ent.name === "route.ts" || ent.name === "route.js")) {
      out.push({ filePath: full, segments: relativeSegments });
    }
  }
}

function extractMethods(source: string): HttpMethod[] {
  const methods = new Set<HttpMethod>();
  for (const match of source.matchAll(METHOD_RE)) {
    methods.add(match[1] as HttpMethod);
  }
  // If no explicit method exports, keep empty (rare, but don't invent).
  return Array.from(methods).sort();
}

function buildMetaIndex() {
  const index = new Map<string, DiscoveredApiRoute["meta"]>();
  for (const ep of API_ENDPOINTS) {
    index.set(`${ep.method} ${ep.path}`, {
      id: ep.id,
      name: ep.name,
      description: ep.description,
      category: ep.category,
      requiresAuth: ep.requiresAuth,
      pricing: ep.pricing,
      rateLimit: ep.rateLimit,
      tags: ep.tags,
    });
  }
  return index;
}

/**
 * Discovers Next.js route handlers under `app/api/v1/<...>/route.ts` and returns
 * a list of OpenAPI-ish paths with supported HTTP methods.
 *
 * This powers docs-side API exploration without needing to manually keep
 * endpoint lists in sync with real code.
 */
export async function discoverApiV1Routes(): Promise<DiscoveredApiRoute[]> {
  const root = path.join(process.cwd(), "app", "api", "v1");
  const discoveredFiles: Array<{ filePath: string; segments: string[] }> = [];

  await walkRoutes(root, [], discoveredFiles);

  const metaIndex = buildMetaIndex();
  const routes: DiscoveredApiRoute[] = [];

  for (const file of discoveredFiles) {
    const source = await fs.readFile(file.filePath, "utf8");
    const methods = extractMethods(source);

    const apiPath =
      "/api/v1" +
      (file.segments.length
        ? `/${file.segments.map(segmentToOpenApi).join("/")}`
        : "");

    // Attach metadata when present for that exact path+method pair.
    // If multiple methods exist, we still keep one meta (best-effort) by
    // preferring the first method match.
    const firstMethod = methods[0];
    const meta = firstMethod
      ? metaIndex.get(`${firstMethod} ${apiPath}`)
      : undefined;

    routes.push({
      path: apiPath,
      methods,
      filePath: file.filePath,
      meta,
    });
  }

  routes.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.methods.join(",").localeCompare(b.methods.join(","));
  });

  return routes;
}
