/**
 * Planner context for the active Project registry selection.
 *
 * The provider exposes the stable project id, local workdir, repository, and
 * Cloud publication binding so project-aware actions can resolve phrases such
 * as "this project" without inventing or caching another selection.
 */

import type {
  IAgentRuntime,
  Memory,
  ProjectRecord,
  Provider,
  State,
} from "@elizaos/core";
import { logger, readProjectRegistryOrThrow } from "@elizaos/core";

function renderActiveProject(project: ProjectRecord | null): string {
  if (!project) {
    return "# Active project\nNo active project is selected.";
  }
  const lines = [
    "# Active project",
    `Name: ${project.name}`,
    `Project id: ${project.id}`,
    `Local path: ${project.localPath}`,
    `Cloud binding: ${project.cloudAppId ? "present" : "none"}`,
  ];
  if (project.repoUrl) lines.push(`Repository: ${project.repoUrl}`);
  if (project.defaultBranch)
    lines.push(`Default branch: ${project.defaultBranch}`);
  if (project.cloudAppId) lines.push(`Cloud app id: ${project.cloudAppId}`);
  return lines.join("\n");
}

export const activeProjectProvider: Provider = {
  name: "ACTIVE_PROJECT",
  description:
    "The active local project and its optional Eliza Cloud publication binding.",
  descriptionCompressed: "Active project path, repository, and Cloud binding.",
  position: 0,
  dynamic: true,
  cacheStable: false,
  cacheScope: "turn",
  contexts: ["code", "tasks", "apps", "agent_internal"],
  contextGate: { anyOf: ["code", "tasks", "apps", "agent_internal"] },
  roleGate: { minRole: "ADMIN" },
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const registry = readProjectRegistryOrThrow();
      const project =
        registry?.projects.find(
          (candidate) => candidate.id === registry.activeProjectId,
        ) ?? null;
      const text = renderActiveProject(project);
      return {
        text,
        values: {
          activeProject: text,
          activeProjectId: project?.id ?? "",
          activeProjectCloudAppId: project?.cloudAppId ?? "",
        },
        data: {
          activeProject: project
            ? {
                id: project.id,
                name: project.name,
                localPath: project.localPath,
                repoUrl: project.repoUrl,
                defaultBranch: project.defaultBranch,
                cloudAppId: project.cloudAppId,
                lastOpenedAt: project.lastOpenedAt,
              }
            : null,
          projectCount: registry?.projects.length ?? 0,
        },
      };
    } catch (err) {
      // error-policy:J7 project context must not kill the planner turn; surface
      // the failure both in RECENT_ERRORS and in-band as unavailable context.
      logger.warn(
        { error: err },
        "[ActiveProjectProvider] Failed to read project registry",
      );
      await runtime.reportError?.(
        "AgentOrchestrator.ACTIVE_PROJECT",
        err instanceof Error ? err : new Error(String(err)),
      );
      const text =
        "# Active project\nProject registry unavailable; do not assume there is no active project.";
      return {
        text,
        values: {
          activeProject: text,
          activeProjectId: "",
          activeProjectCloudAppId: "",
        },
        data: { activeProject: null, projectCount: null, degraded: true },
      };
    }
  },
};
