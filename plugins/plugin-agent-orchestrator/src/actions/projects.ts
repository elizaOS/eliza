/**
 * Agent actions over the core Project registry.
 *
 * These verbs expose the same atomic projects.json read/switch operations used
 * by the desktop project switcher. They never mint, delete, or shadow projects;
 * planner references resolve against stable ids, names, paths, and repositories,
 * with the active project as the deliberate default for singular read requests.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ProjectRecord,
  ProjectRegistry,
  State,
} from "@elizaos/core";
import {
  logger,
  readProjectRegistryOrThrow,
  setActiveProject,
} from "@elizaos/core";

interface ProjectMatch {
  project: ProjectRecord | null;
  candidates: ProjectRecord[];
}

const PROJECT_OPTION_KEYS = [
  "projectId",
  "project",
  "projectName",
  "id",
  "name",
  "query",
] as const;

function optionSources(options: unknown): Record<string, unknown>[] {
  if (!options || typeof options !== "object") return [];
  const top = options as Record<string, unknown>;
  const nested =
    top.parameters && typeof top.parameters === "object"
      ? (top.parameters as Record<string, unknown>)
      : null;
  return nested ? [nested, top] : [top];
}

/** Planner-supplied project reference, with raw user text as the direct-call fallback. */
export function extractProjectReference(
  message: Memory,
  options?: unknown,
): string {
  for (const source of optionSources(options)) {
    for (const key of PROJECT_OPTION_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return (message.content?.text ?? "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsBounded(haystack: string, needle: string): boolean {
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`,
    "i",
  ).test(haystack);
}

function identityFields(project: ProjectRecord): string[] {
  return [
    project.id,
    project.name,
    project.localPath,
    project.repoUrl ?? "",
  ].filter(Boolean);
}

/**
 * Resolve one project without first-match ambiguity. Exact id/name/path/repo
 * wins; otherwise a project whose full name occurs in the request may match.
 */
export function matchProjectReference(
  projects: ProjectRecord[],
  reference: string,
): ProjectMatch {
  const ref = reference.trim();
  if (!ref) return { project: null, candidates: [] };
  const lower = ref.toLowerCase();

  const exact = projects.filter((project) =>
    identityFields(project).some((field) => field.toLowerCase() === lower),
  );
  if (exact.length === 1) return { project: exact[0], candidates: exact };
  if (exact.length > 1) return { project: null, candidates: exact };

  const bounded = projects.filter(
    (project) =>
      project.name.trim().length >= 2 &&
      containsBounded(lower, project.name.toLowerCase()),
  );
  if (bounded.length === 1) {
    return { project: bounded[0], candidates: bounded };
  }
  if (bounded.length > 1) {
    const longest = Math.max(...bounded.map((project) => project.name.length));
    const mostSpecific = bounded.filter(
      (project) => project.name.length === longest,
    );
    return mostSpecific.length === 1
      ? { project: mostSpecific[0], candidates: mostSpecific }
      : { project: null, candidates: mostSpecific };
  }

  const fragments = projects.filter((project) =>
    project.name.toLowerCase().includes(lower),
  );
  return fragments.length === 1
    ? { project: fragments[0], candidates: fragments }
    : { project: null, candidates: fragments };
}

function registryOrEmpty(): ProjectRegistry {
  return (
    readProjectRegistryOrThrow() ?? {
      version: 1,
      activeProjectId: null,
      projects: [],
    }
  );
}

function activeFromRegistry(registry: ProjectRegistry): ProjectRecord | null {
  if (!registry.activeProjectId) return null;
  return (
    registry.projects.find(
      (project) => project.id === registry.activeProjectId,
    ) ?? null
  );
}

function projectSummary(
  project: ProjectRecord,
  activeProjectId: string | null,
) {
  return {
    id: project.id,
    name: project.name,
    localPath: project.localPath,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    cloudAppId: project.cloudAppId,
    isActive: project.id === activeProjectId,
    lastOpenedAt: project.lastOpenedAt,
  };
}

function projectLine(
  project: ProjectRecord,
  activeProjectId: string | null,
): string {
  const tags = [
    project.id === activeProjectId ? "active" : null,
    project.cloudAppId ? "cloud-bound" : null,
  ].filter((tag): tag is string => tag !== null);
  const suffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  return `• ${project.name}${suffix} — ${project.id} — ${project.localPath}`;
}

function ambiguousMessage(candidates: ProjectRecord[]): string {
  return `That project reference is ambiguous. Use the exact name or id: ${candidates
    .map((project) => `${project.name} (${project.id})`)
    .join(", ")}.`;
}

function notFoundMessage(registry: ProjectRegistry): string {
  if (registry.projects.length === 0) {
    return "There are no registered projects yet.";
  }
  return `I couldn't find that project. Registered projects: ${registry.projects
    .map((project) => project.name)
    .join(", ")}.`;
}

function actionError(action: string, text: string, err: unknown): ActionResult {
  logger.error(
    { error: err },
    `[ProjectActions] ${action} failed against the project registry`,
  );
  return {
    success: false,
    text,
    userFacingText: text,
    error: err instanceof Error ? err : new Error(String(err)),
    data: { reason: "registry_error" },
  };
}

export const listProjectsAction: Action = {
  name: "LIST_PROJECTS",
  similes: ["SHOW_PROJECTS", "MY_PROJECTS", "PROJECT_LIST"],
  description:
    "List the user's registered local projects, including which project is active and which projects have an Eliza Cloud binding. Live publication state is checked by GET_PUBLISHED_PROJECT.",
  descriptionCompressed:
    "List registered projects with active and Cloud-binding state.",
  contexts: ["code", "tasks", "apps", "settings"],
  contextGate: { anyOf: ["code", "tasks", "apps", "settings"] },
  roleGate: { minRole: "ADMIN" },
  validate: async (): Promise<boolean> => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const registry = registryOrEmpty();
      const reply =
        registry.projects.length === 0
          ? "There are no registered projects yet."
          : [
              `Registered projects (${registry.projects.length}):`,
              ...registry.projects.map((project) =>
                projectLine(project, registry.activeProjectId),
              ),
            ].join("\n");
      await callback?.({ text: reply, actions: ["LIST_PROJECTS"] });
      return {
        success: true,
        text: `Listed ${registry.projects.length} registered projects.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          activeProjectId: registry.activeProjectId,
          projects: registry.projects.map((project) =>
            projectSummary(project, registry.activeProjectId),
          ),
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary translates registry failure for the planner.
      const result = actionError(
        "LIST_PROJECTS",
        "I couldn't read the project registry right now.",
        err,
      );
      await callback?.({
        text: result.userFacingText,
        actions: ["LIST_PROJECTS"],
      });
      return result;
    }
  },
};

export const getProjectAction: Action = {
  name: "GET_PROJECT",
  similes: ["PROJECT_DETAILS", "SHOW_PROJECT", "CURRENT_PROJECT"],
  description:
    "Show one registered project's local path, repository, active state, and optional Cloud binding. Defaults to the active project when no project is named.",
  descriptionCompressed:
    "Show a project's details; defaults to the active project.",
  contexts: ["code", "tasks", "apps", "settings"],
  contextGate: { anyOf: ["code", "tasks", "apps", "settings"] },
  roleGate: { minRole: "ADMIN" },
  parameters: [
    {
      name: "project",
      description:
        "Optional project name, id, local path, or repository URL. Omit for the active project.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (): Promise<boolean> => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const registry = registryOrEmpty();
      const hasStructuredReference = optionSources(options).some((source) =>
        PROJECT_OPTION_KEYS.some(
          (key) =>
            typeof source[key] === "string" &&
            (source[key] as string).trim().length > 0,
        ),
      );
      const reference = extractProjectReference(message, options);
      const match = matchProjectReference(registry.projects, reference);
      const project =
        match.project ??
        (!hasStructuredReference && match.candidates.length === 0
          ? activeFromRegistry(registry)
          : null);

      if (!project) {
        const reply =
          match.candidates.length > 1
            ? ambiguousMessage(match.candidates)
            : notFoundMessage(registry);
        await callback?.({ text: reply, actions: ["GET_PROJECT"] });
        return {
          success: false,
          text:
            match.candidates.length > 1
              ? "Ambiguous project reference."
              : "Project not found.",
          userFacingText: reply,
          data: {
            reason: match.candidates.length > 1 ? "ambiguous" : "not_found",
            candidates: match.candidates.map((candidate) => candidate.id),
          },
        };
      }

      const lines = [
        `${project.name} (${project.id})`,
        `Path: ${project.localPath}`,
        `Active: ${project.id === registry.activeProjectId ? "yes" : "no"}`,
        `Cloud binding: ${project.cloudAppId ? `Cloud app ${project.cloudAppId}` : "none"}`,
      ];
      if (project.repoUrl) lines.push(`Repository: ${project.repoUrl}`);
      if (project.defaultBranch)
        lines.push(`Default branch: ${project.defaultBranch}`);
      const reply = lines.join("\n");
      await callback?.({ text: reply, actions: ["GET_PROJECT"] });
      return {
        success: true,
        text: `Fetched project ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: projectSummary(project, registry.activeProjectId),
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary translates registry failure for the planner.
      const result = actionError(
        "GET_PROJECT",
        "I couldn't read that project right now.",
        err,
      );
      await callback?.({
        text: result.userFacingText,
        actions: ["GET_PROJECT"],
      });
      return result;
    }
  },
};

export const setActiveProjectAction: Action = {
  name: "SET_ACTIVE_PROJECT",
  similes: ["SWITCH_PROJECT", "SELECT_PROJECT", "USE_PROJECT"],
  description:
    "Switch the active registered project by exact name, id, local path, or repository URL. This changes the default project used by project-aware coding and publishing actions.",
  descriptionCompressed: "Switch the active registered project.",
  contexts: ["code", "tasks", "apps", "settings"],
  contextGate: { anyOf: ["code", "tasks", "apps", "settings"] },
  roleGate: { minRole: "ADMIN" },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "project",
      description:
        "Project name, id, local path, or repository URL to make active.",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
  ],
  validate: async (): Promise<boolean> => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const registry = registryOrEmpty();
      const reference = extractProjectReference(message, options);
      const match = matchProjectReference(registry.projects, reference);
      if (!match.project) {
        const reply =
          match.candidates.length > 1
            ? ambiguousMessage(match.candidates)
            : notFoundMessage(registry);
        await callback?.({ text: reply, actions: ["SET_ACTIVE_PROJECT"] });
        return {
          success: false,
          text:
            match.candidates.length > 1
              ? "Ambiguous project reference."
              : "Project not found.",
          userFacingText: reply,
          data: {
            reason: match.candidates.length > 1 ? "ambiguous" : "not_found",
            candidates: match.candidates.map((candidate) => candidate.id),
          },
        };
      }

      const activated = setActiveProject(match.project.id);
      if (!activated) {
        const reply =
          "That project disappeared before it could be activated. Refresh the project list and try again.";
        await callback?.({ text: reply, actions: ["SET_ACTIVE_PROJECT"] });
        return {
          success: false,
          text: "Project was no longer present during activation.",
          userFacingText: reply,
          data: { reason: "not_found" },
        };
      }
      const reply = `Active project is now "${activated.name}" at ${activated.localPath}.`;
      await callback?.({ text: reply, actions: ["SET_ACTIVE_PROJECT"] });
      return {
        success: true,
        text: `Activated project ${activated.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { project: projectSummary(activated, activated.id) },
      };
    } catch (err) {
      // error-policy:J1 action boundary translates registry failure for the planner.
      const result = actionError(
        "SET_ACTIVE_PROJECT",
        "I couldn't switch the active project right now.",
        err,
      );
      await callback?.({
        text: result.userFacingText,
        actions: ["SET_ACTIVE_PROJECT"],
      });
      return result;
    }
  },
};
