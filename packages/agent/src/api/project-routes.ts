/**
 * HTTP routes for the first-class Project registry (#13776 item 5) — the
 * read/switch surface the UI project switcher is wired to.
 *
 * The registry itself is the merged core store in
 * `@elizaos/core/utils/project-registry` (a `projects.json` snapshot under the
 * per-user state dir). This module is a thin HTTP projection over it:
 *
 *   GET  /api/projects              → { projects, activeProjectId }
 *   POST /api/projects/register     → register an owned local workspace
 *   POST /api/projects/:id/activate → mark a project active, return the record
 *   POST /api/projects/:id/cloud-app → bind its Cloud publication record
 *   DELETE /api/projects/:id/cloud-app → clear a deleted/stale binding
 *
 * The register endpoint is the deliberate exception to the original
 * list-and-switch-only boundary: creation and owner-selected folder flows need
 * one backend write path that uses the same realpath-deduped core registry.
 * Edit/delete remain outside HTTP. Absent registry ⇒ empty list + `null`
 * active, which the switcher renders as its no-projects empty state.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  bindProjectCloudApp,
  ElizaError,
  getActiveProject,
  logger,
  type RouteRequestContext,
  readProjectRegistryOrThrow,
  setActiveProject,
  unbindProjectCloudApp,
  upsertProject,
} from "@elizaos/core";

/** DTO for the switcher: only the fields the UI renders + switches on. Internal
 * bookkeeping (bookmark, createdAt) is intentionally not surfaced. */
export interface ProjectSummaryDTO {
  id: string;
  name: string;
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  /** Live package.json projection; null means this workspace is not launchable. */
  packageName: string | null;
  cloudAppId?: string;
  lastOpenedAt: string;
}

export interface ProjectListDTO {
  projects: ProjectSummaryDTO[];
  activeProjectId: string | null;
}

export interface RegisterProjectDTO {
  name: string;
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
}

/** Project id path segment: a uuid-ish token; reject anything with a slash or
 * whitespace so the route can't be tricked into matching a nested path. */
const PROJECT_ID_PATTERN = /^[\w.-]+$/;

const ACTIVATE_SUFFIX = "/activate";
const CLOUD_APP_SUFFIX = "/cloud-app";
const REGISTER_PATH = "/api/projects/register";
const REGISTER_FIELDS = new Set([
  "name",
  "localPath",
  "repoUrl",
  "defaultBranch",
]);

function toSummary(project: {
  id: string;
  name: string;
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  cloudAppId?: string;
  lastOpenedAt: string;
}): ProjectSummaryDTO {
  return {
    id: project.id,
    name: project.name,
    localPath: project.localPath,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    packageName: readProjectPackageName(project.localPath),
    cloudAppId: project.cloudAppId,
    lastOpenedAt: project.lastOpenedAt,
  };
}

function readProjectPackageName(localPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(localPath, "package.json"), "utf8");
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      // error-policy:J4 a workspace without a manifest is explicitly non-launchable.
      return null;
    }
    throw new ElizaError("Project package manifest could not be read", {
      code: "PROJECT_PACKAGE_READ_FAILED",
      context: { localPath },
      cause,
      severity: "fatal",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 malformed owner-controlled package.json is an invalid package signal.
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const name = (parsed as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function parseProjectId(rawId: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    // error-policy:J3 malformed percent-encoding is an invalid project id.
    return null;
  }
  return id && PROJECT_ID_PATTERN.test(id) ? id : null;
}

function parseRegisterProject(
  body: Record<string, unknown>,
): { ok: true; value: RegisterProjectDTO } | { ok: false; message: string } {
  const unknownField = Object.keys(body).find(
    (field) => !REGISTER_FIELDS.has(field),
  );
  if (unknownField) {
    return { ok: false, message: `Unknown field: ${unknownField}` };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, message: "name is required" };

  const localPath =
    typeof body.localPath === "string" ? body.localPath.trim() : "";
  if (!localPath) return { ok: false, message: "localPath is required" };
  if (!isAbsolute(localPath)) {
    return { ok: false, message: "localPath must be an absolute path" };
  }

  const readOptionalString = (
    field: "repoUrl" | "defaultBranch",
  ): string | undefined | null => {
    const value = body[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) return null;
    return value.trim();
  };
  const repoUrl = readOptionalString("repoUrl");
  if (repoUrl === null) {
    return { ok: false, message: "repoUrl must be a non-empty string" };
  }
  const defaultBranch = readOptionalString("defaultBranch");
  if (defaultBranch === null) {
    return {
      ok: false,
      message: "defaultBranch must be a non-empty string",
    };
  }

  return {
    ok: true,
    value: {
      name,
      localPath,
      ...(repoUrl ? { repoUrl } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
    },
  };
}

/**
 * Serve the project registry register/read/switch endpoints. Returns `true`
 * when the request was handled (so the caller stops the route chain), `false`
 * otherwise.
 *
 * Dependencies are injectable so tests can drive validation and boundary
 * translation without touching a real state dir; integration cases exercise
 * the production core registry.
 */
export async function handleProjectRoutes(
  ctx: RouteRequestContext,
  deps: {
    readRegistry?: () => ProjectListDTO;
    activate?: (id: string) => ProjectSummaryDTO | null;
    register?: (input: RegisterProjectDTO) => ProjectSummaryDTO;
    bindCloudApp?: (
      projectId: string,
      cloudAppId: string,
    ) => ProjectSummaryDTO | null;
    unbindCloudApp?: (projectId: string) => ProjectSummaryDTO | null;
  } = {},
): Promise<boolean> {
  const { method, pathname, req, res, json, error, readJsonBody } = ctx;

  if (!pathname.startsWith("/api/projects")) return false;

  const readRegistry =
    deps.readRegistry ??
    (() => {
      const registry = readProjectRegistryOrThrow();
      const active = getActiveProject();
      return {
        projects: (registry?.projects ?? []).map(toSummary),
        activeProjectId: active?.id ?? registry?.activeProjectId ?? null,
      } satisfies ProjectListDTO;
    });

  const activate =
    deps.activate ??
    ((id: string) => {
      const record = setActiveProject(id);
      return record ? toSummary(record) : null;
    });

  const register =
    deps.register ??
    ((input: RegisterProjectDTO) => toSummary(upsertProject(input)));

  const bindCloudApp =
    deps.bindCloudApp ??
    ((projectId: string, cloudAppId: string) => {
      const record = bindProjectCloudApp(projectId, cloudAppId);
      return record ? toSummary(record) : null;
    });

  const unbindCloudApp =
    deps.unbindCloudApp ??
    ((projectId: string) => {
      const record = unbindProjectCloudApp(projectId);
      return record ? toSummary(record) : null;
    });

  // GET /api/projects — list + active pointer for the switcher.
  if (method === "GET" && pathname === "/api/projects") {
    try {
      json(res, readRegistry());
    } catch (err) {
      // error-policy:J1 local HTTP boundary translates registry failures.
      logger.error({ error: err }, "[projects] Failed to read registry");
      error(res, "Failed to read project registry", 500);
    }
    return true;
  }

  // POST /api/projects/register — deliberately mint or update one project by
  // the core registry's canonical localPath identity. cloudAppId is not an
  // accepted request field: Cloud publication owns that separate write path.
  if (method === "POST" && pathname === REGISTER_PATH) {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (body === null) return true;
    const parsed = parseRegisterProject(body);
    if (!parsed.ok) {
      error(res, parsed.message, 400);
      return true;
    }
    try {
      json(res, register(parsed.value));
    } catch (err) {
      // error-policy:J1 local HTTP boundary translates registry failures.
      logger.error({ error: err }, "[projects] Failed to register project");
      error(res, "Failed to register project", 500);
    }
    return true;
  }

  if (
    (method === "POST" || method === "DELETE") &&
    pathname.startsWith("/api/projects/") &&
    pathname.endsWith(CLOUD_APP_SUFFIX)
  ) {
    const rawId = pathname.slice(
      "/api/projects/".length,
      pathname.length - CLOUD_APP_SUFFIX.length,
    );
    const id = parseProjectId(rawId);
    if (!id) {
      error(res, "Invalid project id", 400);
      return true;
    }

    if (method === "POST") {
      const body = await readJsonBody<Record<string, unknown>>(req, res);
      if (body === null) return true;
      const fields = Object.keys(body);
      if (
        fields.length !== 1 ||
        fields[0] !== "cloudAppId" ||
        typeof body.cloudAppId !== "string" ||
        !body.cloudAppId.trim()
      ) {
        error(res, "cloudAppId is required", 400);
        return true;
      }
      try {
        const bound = bindCloudApp(id, body.cloudAppId.trim());
        if (!bound) {
          error(res, "Project not found", 404);
          return true;
        }
        json(res, bound);
      } catch (err) {
        // error-policy:J1 local HTTP boundary translates registry failures.
        logger.error({ error: err }, "[projects] Failed to bind Cloud app");
        error(res, "Failed to bind project Cloud app", 500);
      }
      return true;
    }

    try {
      const unbound = unbindCloudApp(id);
      if (!unbound) {
        error(res, "Project not found", 404);
        return true;
      }
      json(res, unbound);
    } catch (err) {
      // error-policy:J1 local HTTP boundary translates registry failures.
      logger.error({ error: err }, "[projects] Failed to unbind Cloud app");
      error(res, "Failed to unbind project Cloud app", 500);
    }
    return true;
  }

  // POST /api/projects/:id/activate — switch the active project.
  if (
    method === "POST" &&
    pathname.startsWith("/api/projects/") &&
    pathname.endsWith(ACTIVATE_SUFFIX)
  ) {
    const rawId = pathname.slice(
      "/api/projects/".length,
      pathname.length - ACTIVATE_SUFFIX.length,
    );
    const id = parseProjectId(rawId);
    if (!id) {
      error(res, "Invalid project id", 400);
      return true;
    }
    try {
      const activated = activate(id);
      if (!activated) {
        error(res, "Project not found", 404);
        return true;
      }
      json(res, activated);
    } catch (err) {
      // error-policy:J1 local HTTP boundary translates registry failures.
      logger.error({ error: err }, "[projects] Failed to activate project");
      error(res, "Failed to activate project", 500);
    }
    return true;
  }

  return false;
}
