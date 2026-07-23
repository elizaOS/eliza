/**
 * Resolves planner project references against the atomic core registry.
 *
 * Project-aware Cloud actions share this one ambiguity-safe resolver so “this
 * project” consistently means the active project while explicit names, ids,
 * paths, and repositories never degrade to a first-match guess.
 */

import type { Memory, ProjectRecord, ProjectRegistry } from "@elizaos/core";
import { readProjectRegistryOrThrow } from "@elizaos/core";

const PROJECT_OPTION_KEYS = ["projectId", "project", "projectName"] as const;

export interface ProjectResolution {
  project: ProjectRecord | null;
  registry: ProjectRegistry | null;
  reason?: "no_projects" | "not_found" | "ambiguous" | "no_active";
  candidates: ProjectRecord[];
  reference: string | null;
}

export function projectOptionSources(
  options: unknown,
): Record<string, unknown>[] {
  if (!options || typeof options !== "object") return [];
  const top = options as Record<string, unknown>;
  const nested =
    top.parameters && typeof top.parameters === "object"
      ? (top.parameters as Record<string, unknown>)
      : null;
  return nested ? [nested, top] : [top];
}

function structuredProjectReference(options: unknown): string | null {
  for (const source of projectOptionSources(options)) {
    for (const key of PROJECT_OPTION_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bounded(haystack: string, needle: string): boolean {
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`,
    "i",
  ).test(haystack);
}

function identities(project: ProjectRecord): string[] {
  const values = [
    project.id,
    project.name,
    project.localPath,
    project.repoUrl,
    project.cloudAppId,
  ];
  return values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

/** Resolve a concrete reference without silently choosing an ambiguous match. */
export function matchProject(
  projects: ProjectRecord[],
  reference: string,
): { project: ProjectRecord | null; candidates: ProjectRecord[] } {
  const ref = reference.trim();
  if (!ref) return { project: null, candidates: [] };
  const lower = ref.toLowerCase();
  const exact = projects.filter((project) =>
    identities(project).some((value) => value.toLowerCase() === lower),
  );
  if (exact.length === 1) return { project: exact[0], candidates: exact };
  if (exact.length > 1) return { project: null, candidates: exact };

  const boundedNames = projects.filter(
    (project) =>
      project.name.trim().length >= 2 &&
      bounded(lower, project.name.trim().toLowerCase()),
  );
  if (boundedNames.length === 1) {
    return { project: boundedNames[0], candidates: boundedNames };
  }
  if (boundedNames.length > 1) {
    const longest = Math.max(
      ...boundedNames.map((project) => project.name.length),
    );
    const candidates = boundedNames.filter(
      (project) => project.name.length === longest,
    );
    return {
      project: candidates.length === 1 ? candidates[0] : null,
      candidates,
    };
  }
  return { project: null, candidates: [] };
}

/**
 * Resolve the planner's explicit project, a project named in prose, or the
 * active/sole project in that order.
 */
export function resolveProject(
  message: Memory,
  options?: unknown,
): ProjectResolution {
  const registry = readProjectRegistryOrThrow();
  if (!registry || registry.projects.length === 0) {
    return {
      project: null,
      registry,
      reason: "no_projects",
      candidates: [],
      reference: null,
    };
  }

  const structured = structuredProjectReference(options);
  if (structured) {
    const match = matchProject(registry.projects, structured);
    return {
      ...match,
      registry,
      reason: match.project
        ? undefined
        : match.candidates.length > 1
          ? "ambiguous"
          : "not_found",
      reference: structured,
    };
  }

  const prose = (message.content?.text ?? "").trim();
  const proseMatch = matchProject(registry.projects, prose);
  if (proseMatch.project) {
    return {
      ...proseMatch,
      registry,
      reference: prose,
    };
  }
  if (proseMatch.candidates.length > 1) {
    return {
      ...proseMatch,
      registry,
      reason: "ambiguous",
      reference: prose,
    };
  }

  const active = registry.activeProjectId
    ? (registry.projects.find(
        (project) => project.id === registry.activeProjectId,
      ) ?? null)
    : null;
  const fallback =
    active ?? (registry.projects.length === 1 ? registry.projects[0] : null);
  return {
    project: fallback,
    registry,
    reason: fallback ? undefined : "no_active",
    candidates: [],
    reference: null,
  };
}

/** User-facing project resolution failure shared by every project Cloud verb. */
export function projectResolutionMessage(
  resolution: ProjectResolution,
): string {
  if (resolution.reason === "no_projects") {
    return "There are no registered projects yet. Create or add a project first.";
  }
  if (resolution.reason === "ambiguous") {
    return `Which project do you mean? Use the exact name or id: ${resolution.candidates
      .map((project) => `${project.name} (${project.id})`)
      .join(", ")}.`;
  }
  if (resolution.reason === "not_found") {
    return `I couldn't find a registered project matching "${resolution.reference ?? ""}".`;
  }
  return "Select an active project or tell me the exact project name or id.";
}
