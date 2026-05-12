import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const HONO_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const METHOD_RE =
  /export\s+(?:(?:async\s+)?function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
const METHOD_REEXPORT_RE = /export\s*\{\s*([^}]+)\s*\}\s*from\b/g;
const DEFAULT_REEXPORT_RE = /export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/g;
const HONO_APP_DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Hono\b/g;

const API_ROOT_CANDIDATES = ["apps/api", "app/api"];

async function pathExists(candidate) {
  try {
    await readdir(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function findCloudApiRoot(startDir) {
  let current = startDir;
  while (true) {
    for (const relativeApiRoot of API_ROOT_CANDIDATES) {
      const apiRoot = path.join(current, ...relativeApiRoot.split("/"));
      if (await pathExists(apiRoot)) {
        return { cloudRoot: current, apiRoot, relativeApiRoot };
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

export function segmentToRouteParam(segment) {
  if (!segment.startsWith("[") || !segment.endsWith("]")) {
    return { routeSegment: segment, paramName: null, catchAll: false };
  }

  const inner = segment.slice(1, -1);
  const catchAll = inner.startsWith("...");
  const paramName = catchAll ? inner.slice(3) : inner;
  return { routeSegment: `{${paramName}}`, paramName, catchAll };
}

export function routePathFromSegments(relativeSegments) {
  return (
    "/api" +
    (relativeSegments.length
      ? `/${relativeSegments.map((segment) => segmentToRouteParam(segment).routeSegment).join("/")}`
      : "")
  );
}

export function scopeForRoute(route) {
  if (route.startsWith("/api/internal/")) return "internal";
  if (route.startsWith("/api/cron/") || route.startsWith("/api/v1/cron/")) return "cron";
  if (route.startsWith("/api/v1/admin/") || route === "/api/v1/admin") return "admin";
  if (route.startsWith("/api/admin/") || route === "/api/admin") return "admin";
  if (route.startsWith("/api/v1/dashboard") || route === "/api/v1/api-keys/explorer") {
    return "app-or-dashboard";
  }
  if (route.startsWith("/api/webhooks/")) return "webhook";
  if (route.includes("/webhook")) return "webhook";
  if (route.startsWith("/api/stripe/")) return "billing-webhook-or-checkout";
  if (route.startsWith("/api/mcp") || route.startsWith("/api/mcps/")) return "mcp-transport";
  if (route.startsWith("/api/auth/")) return "auth";
  if (route.startsWith("/api/v1/") || route === "/api/v1") return "public";
  if (route.startsWith("/api/elevenlabs/")) return "public";
  return "app-or-dashboard";
}

export function isGeneratedPublicRoute(route) {
  return scopeForRoute(route) === "public";
}

export async function walkRoutes(dir, relativeSegments = [], out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkRoutes(fullPath, [...relativeSegments, entry.name], out);
        return;
      }
      if (entry.isFile() && entry.name === "route.ts") {
        out.push({ fullPath, relativeSegments });
      }
    }),
  );
  return out;
}

function resolveRouteReexport(specifier, fromFile, cloudRoot) {
  const basePath = specifier.startsWith("@/api/")
    ? path.join(cloudRoot, "apps", specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (!basePath) return null;
  return path.extname(basePath) ? basePath : `${basePath}.ts`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHonoAppNames(source) {
  return Array.from(source.matchAll(HONO_APP_DECL_RE), (match) => match[1]);
}

function extractHonoMethods(source) {
  const methods = new Set();

  for (const appName of extractHonoAppNames(source)) {
    const escapedName = escapeRegExp(appName);
    const methodRe = new RegExp(
      `\\b${escapedName}\\s*\\.\\s*(get|post|put|patch|delete)\\s*\\(`,
      "gi",
    );
    const allRe = new RegExp(`\\b${escapedName}\\s*\\.\\s*all\\s*\\(`, "i");

    for (const match of source.matchAll(methodRe)) {
      methods.add(match[1].toUpperCase());
    }
    if (allRe.test(source)) {
      for (const method of HONO_ALL_METHODS) {
        methods.add(method);
      }
    }
  }

  return methods;
}

export async function extractMethods(source, filePath, cloudRoot, seen = new Set()) {
  if (seen.has(filePath)) return [];
  seen.add(filePath);

  const methods = new Set();
  for (const match of source.matchAll(METHOD_RE)) {
    methods.add(match[1]);
  }
  for (const match of source.matchAll(METHOD_REEXPORT_RE)) {
    for (const exported of match[1].split(",")) {
      const method = exported
        .trim()
        .split(/\s+as\s+/i)[0]
        ?.trim();
      if (HTTP_METHODS.has(method)) methods.add(method);
    }
  }
  for (const method of extractHonoMethods(source)) {
    methods.add(method);
  }
  for (const match of source.matchAll(DEFAULT_REEXPORT_RE)) {
    const targetPath = resolveRouteReexport(match[1], filePath, cloudRoot);
    if (!targetPath) continue;
    const targetSource = await readFile(targetPath, "utf8").catch(() => null);
    if (!targetSource) continue;
    for (const method of await extractMethods(targetSource, targetPath, cloudRoot, seen)) {
      methods.add(method);
    }
  }
  return Array.from(methods).sort();
}
