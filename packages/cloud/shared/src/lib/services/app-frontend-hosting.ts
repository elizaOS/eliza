/**
 * App Frontend Hosting service.
 *
 * First-class managed frontend hosting for Cloud apps: content-addressed static
 * artifacts in R2, an immutable-deployment model with atomic activate/rollback,
 * and a Worker serve path that injects SEO metadata + a page-view beacon at
 * response time. This is the seam that lets an agent ship a *full* app
 * (frontend + optional backend container) on Cloud instead of bringing an
 * external `app_url`.
 *
 * Layering:
 *  - Storage + manifest + lifecycle live here and are pure/deterministic where
 *    possible so they unit-test against the in-memory R2 shim.
 *  - `renderFrontendResponse` is side-effect-free and returns the response
 *    parts plus `isDocument`; the caller (Worker serve path) records the page
 *    view server-side when a document is served (no secret embedded in the page).
 */

import type { App } from "../../db/repositories/apps";
import { appFrontendDeploymentsRepository } from "../../db/repositories/app-frontend-deployments";
import type {
  AppFrontendDeployment,
  FrontendBuildMeta,
  FrontendFileEntry,
  FrontendManifest,
} from "../../db/schemas/app-frontend-deployments";
import { ObjectNamespaces } from "../storage/object-namespace";
import { getRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { logger } from "../utils/logger";

/** A file to publish. `content` is UTF-8 text unless `encoding: "base64"`. */
export interface FrontendUploadFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  contentType?: string;
}

export interface DeployBundleInput {
  app: Pick<App, "id" | "organization_id">;
  files: FrontendUploadFile[];
  entrypoint?: string;
  spaFallback?: boolean;
  buildMeta?: FrontendBuildMeta;
  createdByUserId?: string | null;
  /** Activate the deployment immediately after finalize (default true). */
  activate?: boolean;
}

/** SEO metadata injected into a served HTML document. */
export interface FrontendSeo {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  url?: string | null;
  siteName?: string | null;
  jsonLd?: Record<string, unknown> | null;
}

export interface RenderInput {
  app: Pick<App, "id" | "name" | "description" | "logo_url">;
  deployment: AppFrontendDeployment;
  /** Request path (may include leading slash / query already stripped by caller). */
  requestPath: string;
  seo?: FrontendSeo;
  /** Absolute base for the page-view beacon endpoint; defaults to a relative URL. */
  beaconBase?: string;
}

export interface RenderedResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer | string;
  /** True when the served resource is the HTML entrypoint (a page view). */
  isDocument: boolean;
}

const DEFAULT_ENTRYPOINT = "index.html";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const frontendHostingLimits = {
  maxFiles: () => intFromEnv("ELIZA_FRONTEND_MAX_FILES", 2000),
  maxTotalBytes: () => intFromEnv("ELIZA_FRONTEND_MAX_TOTAL_BYTES", 25 * 1024 * 1024),
  maxFileBytes: () => intFromEnv("ELIZA_FRONTEND_MAX_FILE_BYTES", 10 * 1024 * 1024),
};

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

export function inferContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function isHtml(contentType: string): boolean {
  return contentType.startsWith("text/html");
}

/**
 * Normalize a site-relative path: strip leading slashes, collapse `//`, reject
 * traversal / absolute / protocol-relative paths. Returns null if unsafe.
 */
export function normalizeSitePath(input: string): string | null {
  let path = input.trim();
  if (path.includes("\\")) return null;
  if (path.includes("\0")) return null;
  // strip leading slashes
  path = path.replace(/^\/+/, "");
  if (path === "") return path;
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") return null;
  }
  return segments.join("/");
}

function toBytes(file: FrontendUploadFile): Uint8Array<ArrayBuffer> {
  if (file.encoding === "base64") {
    const binary = atob(file.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(file.content);
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic content hash over the file set + serve config (change detection). */
export async function computeManifestHash(manifest: FrontendManifest): Promise<string> {
  const canonical = JSON.stringify({
    entrypoint: manifest.entrypoint,
    spaFallback: manifest.spaFallback,
    files: [...manifest.files]
      .map((f) => ({ path: f.path, hash: f.hash }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  return sha256Hex(new TextEncoder().encode(canonical));
}

function requireBucket() {
  const bucket = getRuntimeR2Bucket();
  if (!bucket) {
    throw new Error(
      "[AppFrontendHosting] No R2 bucket bound — managed frontend hosting requires the Worker BLOB binding (or a runtime R2 shim in tests).",
    );
  }
  return bucket;
}

export class AppFrontendHostingService {
  private prefixFor(orgId: string, appId: string, deploymentId: string): string {
    return `${ObjectNamespaces.AppFrontends}/${orgId}/${appId}/${deploymentId}/`;
  }

  /**
   * Publish a complete site in one call: create a deployment, write every file
   * to R2 (content-addressed), validate + finalize the manifest, and (by
   * default) activate it. On any failure the deployment is marked `failed` and
   * the error is rethrown.
   */
  async deployBundle(input: DeployBundleInput): Promise<AppFrontendDeployment> {
    const entrypoint = normalizeSitePath(input.entrypoint ?? DEFAULT_ENTRYPOINT);
    if (!entrypoint) throw new Error("Invalid entrypoint path");
    const spaFallback = input.spaFallback ?? true;

    const maxFiles = frontendHostingLimits.maxFiles();
    const maxTotal = frontendHostingLimits.maxTotalBytes();
    const maxFile = frontendHostingLimits.maxFileBytes();

    if (input.files.length === 0) throw new Error("No files to deploy");
    if (input.files.length > maxFiles) {
      throw new Error(`Too many files: ${input.files.length} > ${maxFiles}`);
    }

    const deployment = await appFrontendDeploymentsRepository.create({
      appId: input.app.id,
      r2Prefix: "", // filled once we have the id
      createdByUserId: input.createdByUserId ?? null,
      buildMeta: input.buildMeta ?? { source: "upload" },
    });

    try {
      const r2Prefix = this.prefixFor(
        input.app.organization_id,
        input.app.id,
        deployment.id,
      );
      await appFrontendDeploymentsRepository.markStatus(deployment.id, "uploading");

      const bucket = requireBucket();
      const entries: FrontendFileEntry[] = [];
      const seenPaths = new Set<string>();
      let totalBytes = 0;

      for (const file of input.files) {
        const path = normalizeSitePath(file.path);
        if (!path) throw new Error(`Invalid file path: ${file.path}`);
        if (seenPaths.has(path)) throw new Error(`Duplicate file path: ${path}`);
        seenPaths.add(path);

        const bytes = toBytes(file);
        if (bytes.byteLength > maxFile) {
          throw new Error(`File too large: ${path} (${bytes.byteLength} > ${maxFile})`);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > maxTotal) {
          throw new Error(`Deployment exceeds size cap (${maxTotal} bytes)`);
        }

        const contentType = file.contentType ?? inferContentType(path);
        const hash = await sha256Hex(bytes);
        await bucket.put(`${r2Prefix}${hash}`, bytes, {
          httpMetadata: { contentType },
        });
        entries.push({ path, hash, contentType, size: bytes.byteLength });
      }

      if (!seenPaths.has(entrypoint)) {
        throw new Error(`Entrypoint not found in uploaded files: ${entrypoint}`);
      }

      const manifest: FrontendManifest = { files: entries, entrypoint, spaFallback };
      const contentHash = await computeManifestHash(manifest);

      // Persist the resolved r2_prefix (create seeded it empty), then finalize.
      await appFrontendDeploymentsRepository.setPrefix(deployment.id, r2Prefix);
      await appFrontendDeploymentsRepository.finalize(deployment.id, {
        manifest,
        contentHash,
        fileCount: entries.length,
        totalBytes,
      });

      if (input.activate ?? true) {
        const activated = await appFrontendDeploymentsRepository.activate(
          input.app.id,
          deployment.id,
        );
        if (activated) return activated;
      }
      const fresh = await appFrontendDeploymentsRepository.getById(deployment.id);
      return fresh ?? deployment;
    } catch (error) {
      await appFrontendDeploymentsRepository.markFailed(
        deployment.id,
        error instanceof Error ? error.message : String(error),
      );
      logger.error("[AppFrontendHosting] deployBundle failed", {
        appId: input.app.id,
        deploymentId: deployment.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Activate a specific (ready/superseded) deployment — this is rollback too. */
  async activate(appId: string, deploymentId: string): Promise<AppFrontendDeployment | undefined> {
    const target = await appFrontendDeploymentsRepository.getByIdForApp(appId, deploymentId);
    if (!target) return undefined;
    if (target.status === "pending" || target.status === "uploading" || target.status === "failed") {
      throw new Error(`Deployment ${deploymentId} is not ready to activate (status: ${target.status})`);
    }
    return appFrontendDeploymentsRepository.activate(appId, deploymentId);
  }

  /** Best-effort delete of a deployment's R2 artifacts (call before row delete). */
  async deleteArtifacts(deployment: AppFrontendDeployment): Promise<void> {
    const bucket = getRuntimeR2Bucket();
    if (!bucket || !deployment.manifest) return;
    for (const file of deployment.manifest.files) {
      try {
        await bucket.delete(`${deployment.r2_prefix}${file.hash}`);
      } catch (error) {
        logger.warn("[AppFrontendHosting] failed to delete artifact", {
          key: `${deployment.r2_prefix}${file.hash}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Resolve + render a single request against a deployment's manifest, reading
   * bytes from R2 and injecting SEO + a beacon into the HTML entrypoint. Pure
   * (no DB writes); the caller records the page view when `isDocument` is true.
   */
  async renderFrontendResponse(input: RenderInput): Promise<RenderedResponse> {
    const manifest = input.deployment.manifest;
    if (!manifest) {
      return { status: 404, headers: { "content-type": "text/plain" }, body: "Not deployed", isDocument: false };
    }

    const normalized = normalizeSitePath(input.requestPath) ?? "";
    let lookupPath = normalized === "" || normalized.endsWith("/")
      ? `${normalized}${manifest.entrypoint}`
      : normalized;
    lookupPath = normalizeSitePath(lookupPath) ?? manifest.entrypoint;

    let entry = manifest.files.find((f) => f.path === lookupPath);
    let servedEntrypoint = entry?.path === manifest.entrypoint;

    // SPA fallback: unmatched, non-asset (no file extension) paths → entrypoint.
    if (!entry && manifest.spaFallback && !hasFileExtension(lookupPath)) {
      entry = manifest.files.find((f) => f.path === manifest.entrypoint);
      servedEntrypoint = true;
    }

    if (!entry) {
      // 404: serve the entrypoint body if present (SPA apps 404-in-app), else plain.
      return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not Found", isDocument: false };
    }

    const bucket = requireBucket();
    const obj = await bucket.get(`${input.deployment.r2_prefix}${entry.hash}`);
    if (!obj) {
      return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not Found", isDocument: false };
    }

    const immutableAsset = !isHtml(entry.contentType);
    const headers: Record<string, string> = {
      "content-type": entry.contentType,
      "x-content-type-options": "nosniff",
      etag: `"${entry.hash}"`,
      "cache-control": immutableAsset
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
    };

    if (isHtml(entry.contentType)) {
      let html = await obj.text();
      html = injectSeo(html, input.seo ?? {});
      html = injectBeacon(html, input.app.id, input.beaconBase);
      return { status: 200, headers, body: html, isDocument: servedEntrypoint };
    }

    const body = obj.arrayBuffer ? await obj.arrayBuffer() : await obj.text();
    return { status: 200, headers, body, isDocument: false };
  }
}

function hasFileExtension(path: string): boolean {
  const last = path.split("/").pop() ?? "";
  return last.includes(".") && !last.startsWith(".");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inject SEO metadata into the `<head>` of a served document. Each tag is added
 * only when the document doesn't already declare it, so a site that ships its
 * own meta wins. No-op when the document has no `</head>`.
 */
export function injectSeo(html: string, seo: FrontendSeo): string {
  const headClose = /<\/head\s*>/i;
  if (!headClose.test(html)) return html;

  const tags: string[] = [];
  const lower = html.toLowerCase();

  if (seo.title && !/<title[\s>]/i.test(html)) {
    tags.push(`<title>${escapeHtml(seo.title)}</title>`);
  }
  if (seo.description && !lower.includes('name="description"')) {
    tags.push(`<meta name="description" content="${escapeHtml(seo.description)}" />`);
  }
  if (seo.title && !lower.includes('property="og:title"')) {
    tags.push(`<meta property="og:title" content="${escapeHtml(seo.title)}" />`);
  }
  if (seo.description && !lower.includes('property="og:description"')) {
    tags.push(`<meta property="og:description" content="${escapeHtml(seo.description)}" />`);
  }
  if (seo.image && !lower.includes('property="og:image"')) {
    tags.push(`<meta property="og:image" content="${escapeHtml(seo.image)}" />`);
  }
  if (seo.url && !lower.includes('property="og:url"')) {
    tags.push(`<meta property="og:url" content="${escapeHtml(seo.url)}" />`);
  }
  if (seo.siteName && !lower.includes('property="og:site_name"')) {
    tags.push(`<meta property="og:site_name" content="${escapeHtml(seo.siteName)}" />`);
  }
  if ((seo.title || seo.image) && !lower.includes('name="twitter:card"')) {
    tags.push(`<meta name="twitter:card" content="${seo.image ? "summary_large_image" : "summary"}" />`);
  }
  if (seo.url && !lower.includes('rel="canonical"')) {
    tags.push(`<link rel="canonical" href="${escapeHtml(seo.url)}" />`);
  }
  if (seo.jsonLd && !lower.includes('application/ld+json')) {
    tags.push(
      `<script type="application/ld+json">${JSON.stringify(seo.jsonLd).replace(/</g, "\\u003c")}</script>`,
    );
  }

  if (tags.length === 0) return html;
  const block = `\n<!-- eliza:seo -->\n${tags.join("\n")}\n<!-- /eliza:seo -->\n`;
  return html.replace(headClose, `${block}</head>`);
}

/**
 * Inject a lightweight page-view beacon that reports SPA route changes
 * (pushState/replaceState/popstate) to `/api/v1/track/pageview`. The initial
 * document load is recorded server-side by the serve path, so the beacon only
 * fires on client-side navigations to avoid double counting. `app_id` is public
 * (page views are non-sensitive), so no secret is embedded.
 */
export function injectBeacon(html: string, appId: string, beaconBase?: string): string {
  const bodyClose = /<\/body\s*>/i;
  if (!bodyClose.test(html)) return html;
  const url = `${(beaconBase ?? "").replace(/\/$/, "")}/api/v1/track/pageview`;
  const script = `<script>(function(){function s(){try{var d={app_id:${JSON.stringify(appId)},page_url:location.pathname+location.search,referrer:document.referrer,pathname:location.pathname,screen_width:screen.width,screen_height:screen.height};navigator.sendBeacon(${JSON.stringify(url)},new Blob([JSON.stringify(d)],{type:"text/plain"}));}catch(e){}}var p=history.pushState,r=history.replaceState;history.pushState=function(){p.apply(this,arguments);s();};history.replaceState=function(){r.apply(this,arguments);s();};addEventListener("popstate",s);})();</script>`;
  return html.replace(bodyClose, `${script}</body>`);
}

export const appFrontendHostingService = new AppFrontendHostingService();
