/**
 * Shared view-switching matrix used by UI-smoke specs to cover core app
 * navigation paths.
 */
export type CoreViewSwitchTarget = {
  id: string;
  label: string;
  path: string;
  kind: "core-view" | "settings-section";
  readySelector?: string;
};

export type ViewSwitchPair = {
  source: CoreViewSwitchTarget;
  target: CoreViewSwitchTarget;
};

export const REQUIRED_CORE_VIEW_IDS = [
  "knowledge",
  "character",
  "settings",
  "tasks",
  "automations",
  "orchestrator",
  "transcripts",
  "wallet",
  "browser",
  "files",
  "skills",
  "feed",
  "relationships",
  "logs",
  "database",
  "trajectories",
] as const;

// Mirrors the canonical `SETTINGS_SECTION_META` order (id + group ordering is the
// single source of truth in packages/ui/src/components/settings/settings-section-meta.ts).
// Kept in lockstep with it — the view-switching coverage gate asserts equality.
export const REQUIRED_SETTINGS_SECTION_IDS = [
  "identity",
  "ai-model",
  "voice",
  "capabilities",
  "apps",
  "connectors",
  "appearance",
  "background",
  "notifications",
  "runtime",
  "wallet-rpc",
  "remote-plugins",
  "updates",
  "advanced",
  "secrets",
  "permissions",
  "app-permissions",
  "security",
] as const;

export const CORE_VIEW_SWITCH_TARGETS: readonly CoreViewSwitchTarget[] = [
  {
    id: "knowledge",
    label: "Knowledge",
    path: "/character/documents",
    kind: "core-view",
    readySelector: '[data-testid="documents-view"]',
  },
  {
    id: "character",
    label: "Character",
    path: "/character",
    kind: "core-view",
    readySelector: '[data-testid="character-editor-view"]',
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    kind: "core-view",
    readySelector: '[data-testid="settings-shell"]',
  },
  {
    id: "tasks",
    label: "Tasks",
    path: "/apps/tasks",
    kind: "core-view",
    readySelector: '[data-testid="tasks-view"]',
  },
  {
    id: "automations",
    label: "Automations",
    path: "/automations",
    kind: "core-view",
    readySelector: '[data-testid="automations-shell"]',
  },
  {
    id: "orchestrator",
    label: "Orchestrator",
    path: "/orchestrator",
    kind: "core-view",
    readySelector: '[data-testid="orchestrator-workbench"]',
  },
  {
    id: "transcripts",
    label: "Transcripts",
    path: "/apps/transcripts",
    kind: "core-view",
    readySelector: '[data-testid="live-meeting-page"]',
  },
  {
    id: "wallet",
    label: "Wallet",
    path: "/wallet",
    kind: "core-view",
    readySelector: '[data-testid="wallet-shell"]',
  },
  {
    id: "browser",
    label: "Browser",
    path: "/browser",
    kind: "core-view",
    readySelector: '[data-testid="browser-workspace-view"]',
  },
  {
    id: "files",
    label: "Files",
    path: "/apps/files",
    kind: "core-view",
    readySelector: '[data-testid="files-view"]',
  },
  {
    id: "skills",
    label: "Skills",
    path: "/apps/skills",
    kind: "core-view",
    readySelector: '[data-testid="skills-shell"]',
  },
  {
    id: "feed",
    label: "Feed",
    path: "/feed",
    kind: "core-view",
    readySelector: 'main:has-text("Spawn agent")',
  },
  {
    id: "relationships",
    label: "Relationships",
    path: "/apps/relationships",
    kind: "core-view",
    readySelector: '[data-testid="relationships-view"]',
  },
  {
    id: "logs",
    label: "Log Viewer",
    path: "/apps/logs",
    kind: "core-view",
    readySelector: '[data-testid="logs-view"]',
  },
  {
    id: "database",
    label: "Database Viewer",
    path: "/apps/database",
    kind: "core-view",
    readySelector: '[data-testid="database-view"]',
  },
  {
    id: "trajectories",
    label: "Trajectory Viewer",
    path: "/apps/trajectories",
    kind: "core-view",
    readySelector: '[data-testid="trajectories-view"]',
  },
] as const;

export const SETTINGS_SECTION_SWITCH_TARGETS: readonly CoreViewSwitchTarget[] =
  REQUIRED_SETTINGS_SECTION_IDS.map((id) => ({
    id: `settings.${id}`,
    label: `Settings ${id}`,
    path: `/settings#${id}`,
    kind: "settings-section" as const,
    readySelector: `#${id}`,
  }));

function orderedPairs(
  targets: readonly CoreViewSwitchTarget[],
): ViewSwitchPair[] {
  return targets.flatMap((source) =>
    targets
      .filter((target) => target.id !== source.id)
      .map((target) => ({ source, target })),
  );
}

export const CORE_VIEW_SWITCH_PAIRS = orderedPairs(CORE_VIEW_SWITCH_TARGETS);

export const SETTINGS_SECTION_SWITCH_PAIRS = orderedPairs(
  SETTINGS_SECTION_SWITCH_TARGETS,
);

export const ALL_REQUIRED_VIEW_SWITCH_TARGETS = [
  ...CORE_VIEW_SWITCH_TARGETS,
  ...SETTINGS_SECTION_SWITCH_TARGETS,
] as const;
