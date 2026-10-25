/**
 * Typed client lib for an app's managed frontend hosting
 * (`/api/v1/apps/:id/frontend*`). This is the human-UI seam for the endpoints
 * that previously had only agent-action + SDK callers (#10690, architecture
 * rule 10): list deployments, publish a static bundle, activate (the rollback
 * primitive), and delete a non-active deployment.
 *
 * The deployment shape mirrors the server row
 * (`packages/cloud/shared/src/db/schemas/app-frontend-deployments.ts`) with
 * timestamps serialized to ISO strings.
 */

import { api } from "../../lib/api-client";

export type FrontendDeploymentStatus =
  | "pending"
  | "uploading"
  | "ready"
  | "active"
  | "superseded"
  | "failed";

export interface FrontendBuildMeta {
  source?: string | null;
  framework?: string | null;
  gitCommit?: string | null;
  note?: string | null;
}

export interface FrontendDeployment {
  id: string;
  app_id: string;
  version: number;
  status: FrontendDeploymentStatus;
  file_count: number;
  total_bytes: number;
  build_meta: FrontendBuildMeta;
  error: string | null;
  created_at: string;
  activated_at: string | null;
  finalized_at: string | null;
}

export interface FrontendDeploymentsList {
  active_deployment_id: string | null;
  deployments: FrontendDeployment[];
}

/** One file entry in a publish payload (server FileSchema). */
export interface FrontendBundleFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  contentType?: string;
}

/** GET /api/v1/apps/:id/frontend — deployments (version DESC) + the active id. */
export async function listFrontendDeployments(
  appId: string,
): Promise<FrontendDeploymentsList> {
  const data = await api<{
    active_deployment_id: string | null;
    deployments: FrontendDeployment[];
  }>(`/api/v1/apps/${appId}/frontend`);
  return {
    active_deployment_id: data.active_deployment_id,
    deployments: data.deployments,
  };
}

/** POST /api/v1/apps/:id/frontend — publish a static-site bundle. */
export async function publishFrontendBundle(
  appId: string,
  input: {
    files: FrontendBundleFile[];
    entrypoint?: string;
    spaFallback?: boolean;
    activate?: boolean;
    buildMeta?: FrontendBuildMeta;
  },
): Promise<FrontendDeployment> {
  const data = await api<{ deployment: FrontendDeployment }>(
    `/api/v1/apps/${appId}/frontend`,
    {
      method: "POST",
      json: { ...input, buildMeta: input.buildMeta ?? { source: "dashboard" } },
    },
  );
  return data.deployment;
}

/**
 * POST /api/v1/apps/:id/frontend/:deploymentId/activate — atomically make the
 * target deployment live. Activating an older version IS the rollback.
 */
export async function activateFrontendDeployment(
  appId: string,
  deploymentId: string,
): Promise<FrontendDeployment> {
  const data = await api<{ deployment: FrontendDeployment }>(
    `/api/v1/apps/${appId}/frontend/${deploymentId}/activate`,
    { method: "POST" },
  );
  return data.deployment;
}

/** DELETE /api/v1/apps/:id/frontend/:deploymentId — non-active only (409 otherwise). */
export async function deleteFrontendDeployment(
  appId: string,
  deploymentId: string,
): Promise<void> {
  await api(`/api/v1/apps/${appId}/frontend/${deploymentId}`, {
    method: "DELETE",
  });
}

/** Owner preview path for a deployment (active when no id passed). */
export function frontendPreviewPath(
  appId: string,
  deploymentId?: string,
): string {
  const base = `/api/v1/apps/${appId}/frontend/preview/`;
  return deploymentId ? `${base}?deployment=${deploymentId}` : base;
}

// ---------------------------------------------------------------------------
// Browser File[] → publish payload
// ---------------------------------------------------------------------------

/** Server-side per-bundle limits (mirrors `frontendHostingLimits` defaults). */
export const FRONTEND_BUNDLE_LIMITS = {
  maxFiles: 2000,
  maxTotalBytes: 25 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
} as const;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The relative path a picked File carries (folder uploads set webkitRelativePath). */
function fileRelativePath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  return rel && rel.length > 0 ? rel : file.name;
}

/**
 * Strip the single shared top-level directory a folder upload prefixes onto
 * every path (`dist/index.html` → `index.html`). Paths stay untouched when the
 * files do not all share one root directory.
 */
export function stripCommonRootDir(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const firstSegment = (p: string) => p.split("/")[0];
  const root = firstSegment(paths[0]);
  const allShareRoot = paths.every(
    (p) => p.includes("/") && firstSegment(p) === root,
  );
  if (!allShareRoot) return paths;
  return paths.map((p) => p.slice(root.length + 1));
}

/**
 * Convert picked browser files into publish payload entries: base64-encoded
 * content, folder-root stripping, client-side limit checks (the server
 * enforces the same limits authoritatively). Throws `Error` with an i18n-able
 * code-like message on limit violations so the caller can surface it.
 */
export async function filesToBundle(
  files: readonly File[],
): Promise<FrontendBundleFile[]> {
  if (files.length === 0) throw new Error("bundle_empty");
  if (files.length > FRONTEND_BUNDLE_LIMITS.maxFiles) {
    throw new Error("bundle_too_many_files");
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > FRONTEND_BUNDLE_LIMITS.maxTotalBytes) {
    throw new Error("bundle_too_large");
  }
  const oversized = files.find(
    (f) => f.size > FRONTEND_BUNDLE_LIMITS.maxFileBytes,
  );
  if (oversized) throw new Error("bundle_file_too_large");

  const paths = stripCommonRootDir(files.map(fileRelativePath));
  return Promise.all(
    files.map(async (file, i) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entry: FrontendBundleFile = {
        path: paths[i],
        content: bytesToBase64(bytes),
        encoding: "base64",
      };
      if (file.type) entry.contentType = file.type;
      return entry;
    }),
  );
}
