/**
 * HTTP routes for the first-class Project registry (#13776 item 5) — the
 * read/switch surface the UI project switcher is wired to.
 *
 * The registry itself is the merged core store in
 * `@elizaos/core/utils/project-registry` (a `projects.json` snapshot under the
 * per-user state dir). This module is a thin HTTP projection over it:
 *
 *   GET  /api/projects            → { projects, activeProjectId }
 *   POST /api/projects/:id/activate → mark a project active, return the record
 *
 * Registration/edit/delete of projects flows through the desktop folder picker
 * write-through (owned elsewhere); this route deliberately exposes only the
 * list + switch verbs the switcher needs so it can never mint/destroy projects
 * behind the user's back. Absent registry ⇒ empty list + `null` active, which
 * the switcher renders as its no-projects empty state.
 */
import {
  getActiveProject,
  logger,
  type RouteRequestContext,
  readProjectRegistry,
  setActiveProject,
} from "@elizaos/core";

/** DTO for the switcher: only the fields the UI renders + switches on. Internal
 * bookkeeping (bookmark, createdAt) is intentionally not surfaced. */
export interface ProjectSummaryDTO {
  id: string;
  name: string;
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  lastOpenedAt: string;
}

export interface ProjectListDTO {
  projects: ProjectSummaryDTO[];
  activeProjectId: string | null;
}

/** Project id path segment: a uuid-ish token; reject anything with a slash or
 * whitespace so the route can't be tricked into matching a nested path. */
const PROJECT_ID_PATTERN = /^[\w.-]+$/;

const ACTIVATE_SUFFIX = "/activate";

function toSummary(project: {
  id: string;
  name: string;
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  lastOpenedAt: string;
}): ProjectSummaryDTO {
  return {
    id: project.id,
    name: project.name,
    localPath: project.localPath,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    lastOpenedAt: project.lastOpenedAt,
  };
}

/**
 * Serve the project registry read + switch endpoints. Returns `true` when the
 * request was handled (so the caller stops the route chain), `false` otherwise.
 *
 * `readRegistry` / `activate` are injectable so tests drive the handler without
 * touching a real state dir; production wiring binds the core registry.
 */
export async function handleProjectRoutes(
  ctx: RouteRequestContext,
  deps: {
    readRegistry?: () => ProjectListDTO;
    activate?: (id: string) => ProjectSummaryDTO | null;
  } = {},
): Promise<boolean> {
  const { method, pathname, res, json, error } = ctx;

  if (!pathname.startsWith("/api/projects")) return false;

  const readRegistry =
    deps.readRegistry ??
    (() => {
      const registry = readProjectRegistry();
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

  // GET /api/projects — list + active pointer for the switcher.
  if (method === "GET" && pathname === "/api/projects") {
    try {
      json(res, readRegistry());
    } catch (err) {
      logger.error({ error: err }, "[projects] Failed to read registry");
      error(res, "Failed to read project registry", 500);
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
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      // error-policy:J3 untrusted path segment — malformed percent-encoding is
      // an invalid project id, not a route/server failure.
      error(res, "Invalid project id", 400);
      return true;
    }
    if (!id || !PROJECT_ID_PATTERN.test(id)) {
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
      logger.error({ error: err }, "[projects] Failed to activate project");
      error(res, "Failed to activate project", 500);
    }
    return true;
  }

  return false;
}
