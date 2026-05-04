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

type ApiRouteMeta = Pick<
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
  meta?: ApiRouteMeta;
  metaByMethod?: Partial<Record<HttpMethod, ApiRouteMeta>>;
}

interface PublicApiRoot {
  dirName: string;
  urlPrefix: string;
}

const METHOD_RE =
  /export\s+(?:(?:async\s+)?function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
const METHOD_REEXPORT_RE = /export\s*\{\s*([^}]+)\s*\}\s*from\b/g;
const DEFAULT_REEXPORT_RE = /export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/g;
const HONO_METHOD_RE = /\b(?:app|honoRouter|__hono_app)\s*\.\s*(get|post|put|patch|delete)\s*\(/gi;
const HONO_ALL_RE = /\b(?:app|honoRouter|__hono_app)\s*\.\s*all\s*\(/i;
const HONO_ALL_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const API_ROOT_CANDIDATES = ["apps/api", "app/api"];

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

  await Promise.all(
    entries.map(async (ent) => {
      if (ent.name.startsWith(".")) return;

      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walkRoutes(full, [...relativeSegments, ent.name], out);
        return;
      }

      // Route handler file
      if (
        ent.isFile() &&
        (ent.name === "route.ts" || ent.name === "route.tsx" || ent.name === "route.js")
      ) {
        out.push({ filePath: full, segments: relativeSegments });
      }
    }),
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.readdir(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findCloudApiRoot(startDir: string): Promise<{ apiRoot: string }> {
  let current = startDir;
  while (true) {
    for (const relativeApiRoot of API_ROOT_CANDIDATES) {
      const apiRoot = path.join(current, ...relativeApiRoot.split("/"));
      if (await pathExists(apiRoot)) {
        return { apiRoot };
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not find cloud API route directory (${API_ROOT_CANDIDATES.join(
          " or ",
        )}) from ${startDir}`,
      );
    }
    current = parent;
  }
}

function resolveRouteReexport(specifier: string, fromFile: string, apiRoot: string): string | null {
  const basePath = specifier.startsWith("@/api/")
    ? path.join(apiRoot, specifier.slice("@/api/".length))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;

  if (!basePath) return null;
  return path.extname(basePath) ? basePath : `${basePath}.ts`;
}

async function extractMethods(
  source: string,
  filePath: string,
  apiRoot: string,
  seen = new Set<string>(),
): Promise<HttpMethod[]> {
  if (seen.has(filePath)) return [];
  seen.add(filePath);

  const methods = new Set<HttpMethod>();
  for (const match of source.matchAll(METHOD_RE)) {
    methods.add(match[1] as HttpMethod);
  }
  for (const match of source.matchAll(METHOD_REEXPORT_RE)) {
    for (const exported of match[1].split(",")) {
      const method = exported
        .trim()
        .split(/\s+as\s+/i)[0]
        ?.trim();
      if (
        method === "GET" ||
        method === "POST" ||
        method === "PUT" ||
        method === "PATCH" ||
        method === "DELETE" ||
        method === "OPTIONS" ||
        method === "HEAD"
      ) {
        methods.add(method);
      }
    }
  }

  for (const match of source.matchAll(HONO_METHOD_RE)) {
    methods.add(match[1].toUpperCase() as HttpMethod);
  }
  if (HONO_ALL_RE.test(source)) {
    for (const method of HONO_ALL_METHODS) {
      methods.add(method);
    }
  }

  for (const match of source.matchAll(DEFAULT_REEXPORT_RE)) {
    const targetPath = resolveRouteReexport(match[1], filePath, apiRoot);
    if (!targetPath) continue;
    const targetSource = await fs.readFile(targetPath, "utf8").catch(() => null);
    if (!targetSource) continue;
    for (const method of await extractMethods(targetSource, targetPath, apiRoot, seen)) {
      methods.add(method);
    }
  }

  return Array.from(methods)
    .filter((method) => method !== "OPTIONS" && method !== "HEAD")
    .sort();
}

function buildMetaIndex() {
  const index = new Map<string, ApiRouteMeta>();
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

const PUBLIC_API_ROOTS: PublicApiRoot[] = [
  { dirName: "v1", urlPrefix: "/api/v1" },
  { dirName: "elevenlabs", urlPrefix: "/api/elevenlabs" },
];

/**
 * Discovers public route handlers and returns a list of OpenAPI-ish
 * paths with supported HTTP methods.
 *
 * This powers docs-side API exploration without needing to manually keep
 * endpoint lists in sync with real code.
 */
export async function discoverPublicApiRoutes(): Promise<DiscoveredApiRoute[]> {
  const { apiRoot } = await findCloudApiRoot(process.cwd());
  const metaIndex = buildMetaIndex();
  const routes: DiscoveredApiRoute[] = [];

  for (const root of PUBLIC_API_ROOTS) {
    const discoveredFiles: Array<{ filePath: string; segments: string[] }> = [];
    await walkRoutes(path.join(apiRoot, root.dirName), [], discoveredFiles);

    routes.push(
      ...(await Promise.all(
        discoveredFiles.map(async (file) => {
          const source = await fs.readFile(file.filePath, "utf8");
          const methods = await extractMethods(source, file.filePath, apiRoot);

          const apiPath =
            root.urlPrefix +
            (file.segments.length
              ? `/${file.segments.map(segmentToOpenApi).join("/")}`
              : "");

          const metaByMethod = Object.fromEntries(
            methods.flatMap((method) => {
              const meta = metaIndex.get(`${method} ${apiPath}`);
              return meta ? [[method, meta]] : [];
            }),
          ) as Partial<Record<HttpMethod, ApiRouteMeta>>;
          const meta = methods[0] ? metaByMethod[methods[0]] : undefined;

          return {
            path: apiPath,
            methods,
            filePath: file.filePath,
            meta,
            metaByMethod,
          };
        }),
      )),
    );
  }

  routes.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.methods.join(",").localeCompare(b.methods.join(","));
  });

  return routes;
}

// Backwards-compatible alias for older call sites.
export async function discoverApiV1Routes(): Promise<DiscoveredApiRoute[]> {
  return discoverPublicApiRoutes();
}
