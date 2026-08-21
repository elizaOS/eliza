/**
 * Closed route registry for the all-views aesthetic audit. Built-in routes
 * mirror the navigation table while plugin routes come from the shared UI-smoke
 * registry, giving capture and semantic-coverage tests one identical case set.
 */
import { VIEW_CASES } from "./plugin-view-cases";

export const BUILTIN_TAB_PATHS: Record<string, string> = {
  chat: "/chat",
  phone: "/phone",
  messages: "/messages",
  contacts: "/contacts",
  camera: "/camera",
  tasks: "/apps/tasks",
  browser: "/browser",
  stream: "/stream",
  "pendant-transcript": "/pendant/transcript",
  apps: "/apps",
  views: "/views",
  character: "/character",
  "character-select": "/character/select",
  automations: "/automations",
  inventory: "/wallet",
  documents: "/character/documents",
  "character-skills": "/character/skills",
  experience: "/character/experience",
  files: "/apps/files",
  plugins: "/apps/plugins",
  skills: "/apps/skills",
  trajectories: "/apps/trajectories",
  transcripts: "/apps/transcripts",
  relationships: "/apps/relationships",
  memories: "/apps/memories",
  rolodex: "/rolodex",
  runtime: "/apps/runtime",
  database: "/apps/database",
  desktop: "/desktop",
  settings: "/settings",
  vault: "/vault",
  logs: "/apps/logs",
  background: "/background",
};

export interface AuditViewCase {
  id: string;
  slug: string;
  path: string;
  viewType: "gui" | "tui";
  kind: "builtin" | "plugin";
}

export function buildAuditViewCases(): AuditViewCase[] {
  return [
    ...Object.entries(BUILTIN_TAB_PATHS).map(
      ([id, path]): AuditViewCase => ({
        id,
        slug: `builtin-${id}`,
        path,
        viewType: "gui",
        kind: "builtin",
      }),
    ),
    {
      id: "workflow-studio",
      slug: "builtin-workflow-studio",
      path: "/automations#automations/__new__",
      viewType: "gui",
      kind: "builtin",
    },
    ...VIEW_CASES.map(
      (view): AuditViewCase => ({
        id: view.id,
        slug: `plugin-${view.id}-${view.viewType}`,
        path: view.path,
        viewType: view.viewType,
        kind: "plugin",
      }),
    ),
  ];
}
