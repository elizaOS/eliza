/**
 * Carries explicitly requested aesthetic-audit projects from the Playwright
 * launcher into configuration reloads while keeping default E2E audit-free.
 */

export const UI_SMOKE_AUDIT_PROJECTS = Object.freeze([
  "audit-app",
  "audit-cloud",
  "audit-app-dropdown",
]);

export const UI_SMOKE_AUDIT_PROJECTS_ENV =
  "ELIZA_UI_SMOKE_REQUESTED_AUDIT_PROJECTS";

export function auditProjectsRequestedByArgs(argv) {
  const requested = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const project = value.startsWith("--project=")
      ? value.slice("--project=".length)
      : value === "--project"
        ? argv[index + 1]
        : null;
    if (project && UI_SMOKE_AUDIT_PROJECTS.includes(project)) {
      requested.add(project);
    }
  }
  return UI_SMOKE_AUDIT_PROJECTS.filter((project) => requested.has(project));
}

export function propagatedAuditProjects(serialized) {
  if (!serialized?.trim()) return [];
  const projects = serialized
    .split(",")
    .map((project) => project.trim())
    .filter(Boolean);
  const unsupported = projects.filter(
    (project) => !UI_SMOKE_AUDIT_PROJECTS.includes(project),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported propagated UI-smoke audit project(s): ${unsupported.join(", ")}`,
    );
  }
  return UI_SMOKE_AUDIT_PROJECTS.filter((project) =>
    projects.includes(project),
  );
}

export function resolveRequestedAuditProjects({ argv, serialized }) {
  const requested = new Set([
    ...auditProjectsRequestedByArgs(argv),
    ...propagatedAuditProjects(serialized),
  ]);
  return UI_SMOKE_AUDIT_PROJECTS.filter((project) => requested.has(project));
}

export function writeAuditProjectPropagation(targetEnv, projects) {
  const requested = new Set(projects);
  const serialized = UI_SMOKE_AUDIT_PROJECTS.filter((project) =>
    requested.has(project),
  ).join(",");
  if (serialized) {
    targetEnv[UI_SMOKE_AUDIT_PROJECTS_ENV] = serialized;
  } else {
    delete targetEnv[UI_SMOKE_AUDIT_PROJECTS_ENV];
  }
}
