import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_CORE_VIEW_IDS,
  REQUIRED_SETTINGS_SECTION_IDS,
} from "./ui-smoke/view-switching-core-matrix";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

type CoreSurfaceOwner = {
  viewId: string;
  provider: "shell" | "dynamic";
  files: readonly string[];
  minAgentElements: number;
  requiredSnippets?: readonly string[];
};

const CORE_SURFACE_OWNERS: Readonly<Record<string, CoreSurfaceOwner>> = {
  tutorial: {
    viewId: "tutorial",
    provider: "shell",
    files: ["packages/ui/src/components/pages/tutorial/TutorialView.tsx"],
    minAgentElements: 1,
    requiredSnippets: ["tutorial-start"],
  },
  help: {
    viewId: "help",
    provider: "shell",
    files: ["packages/ui/src/components/pages/help/HelpView.tsx"],
    minAgentElements: 2,
    requiredSnippets: ["help-entry-", "help-link-"],
  },
  knowledge: {
    viewId: "documents",
    provider: "shell",
    files: [
      "packages/ui/src/components/character/CharacterEditor.tsx",
      "packages/ui/src/components/character/CharacterHubView.tsx",
      "packages/ui/src/components/pages/DocumentsView.tsx",
      "packages/ui/src/components/pages/documents-upload.tsx",
    ],
    minAgentElements: 4,
  },
  character: {
    viewId: "character",
    provider: "shell",
    files: [
      "packages/ui/src/components/character/CharacterEditor.tsx",
      "packages/ui/src/components/character/CharacterEditorPanels.tsx",
      "packages/ui/src/components/character/CharacterExperienceWorkspace.tsx",
    ],
    minAgentElements: 8,
  },
  settings: {
    viewId: "settings",
    provider: "shell",
    files: [
      "packages/ui/src/components/pages/SettingsView.tsx",
      "packages/ui/src/components/settings/settings-agent-rows.tsx",
    ],
    minAgentElements: 2,
  },
  tasks: {
    viewId: "tasks",
    provider: "shell",
    files: [
      "packages/ui/src/components/pages/TasksPageView.tsx",
      "plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.tsx",
      "plugins/plugin-task-coordinator/src/TaskCardList.tsx",
    ],
    minAgentElements: 3,
  },
  automations: {
    viewId: "automations",
    provider: "shell",
    files: ["packages/ui/src/components/pages/AutomationsFeed.tsx"],
    minAgentElements: 4,
    requiredSnippets: ["action-new", "run-workflow-"],
  },
  orchestrator: {
    viewId: "orchestrator",
    provider: "dynamic",
    files: ["plugins/plugin-task-coordinator/src/OrchestratorWorkbench.tsx"],
    minAgentElements: 12,
  },
  transcripts: {
    viewId: "transcripts",
    provider: "shell",
    files: ["packages/ui/src/components/transcripts/TranscriptsView.tsx"],
    minAgentElements: 1,
    requiredSnippets: ["transcript-"],
  },
  wallet: {
    viewId: "wallet",
    provider: "dynamic",
    files: ["plugins/plugin-wallet-ui/src/components/InventoryAppView.tsx"],
    minAgentElements: 5,
  },
  browser: {
    viewId: "browser",
    provider: "shell",
    files: ["packages/ui/src/components/pages/BrowserWorkspaceView.tsx"],
    minAgentElements: 4,
  },
  files: {
    viewId: "files",
    provider: "shell",
    files: ["packages/ui/src/components/pages/FilesView.tsx"],
    minAgentElements: 5,
    requiredSnippets: ["file-facet-", "file-download-", "file-delete-"],
  },
  skills: {
    viewId: "skills",
    provider: "shell",
    files: [
      "packages/ui/src/components/pages/SkillsView.tsx",
      "packages/ui/src/components/pages/skill-detail-panel.tsx",
      "packages/ui/src/components/pages/skill-marketplace.tsx",
    ],
    minAgentElements: 6,
  },
  feed: {
    viewId: "feed",
    provider: "dynamic",
    files: ["plugins/plugin-feed/src/components/FeedSpatialView.tsx"],
    minAgentElements: 2,
  },
  relationships: {
    viewId: "relationships",
    provider: "shell",
    files: [
      "packages/ui/src/components/pages/RelationshipsView.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsWorkspaceView.tsx",
      "packages/ui/src/components/pages/relationships/RelationshipsPersonPanels.tsx",
    ],
    minAgentElements: 4,
  },
  logs: {
    viewId: "logs",
    provider: "shell",
    files: ["packages/ui/src/components/pages/LogsView.tsx"],
    minAgentElements: 4,
  },
  database: {
    viewId: "database",
    provider: "shell",
    files: [
      "packages/ui/src/components/pages/DatabasePageView.tsx",
      "packages/ui/src/components/pages/DatabaseView.tsx",
    ],
    minAgentElements: 2,
  },
  trajectories: {
    viewId: "trajectories",
    provider: "shell",
    files: [
      "packages/ui/src/components/pages/TrajectoriesView.tsx",
      "packages/ui/src/components/pages/TrajectoryDetailView.tsx",
    ],
    minAgentElements: 4,
    requiredSnippets: [
      "trajectories-export-open",
      "trajectories-delete-current-confirm",
      "trajectory-${agentSafeId",
    ],
  },
};

const SETTINGS_SECTION_OWNER_FILES: Readonly<
  Record<string, readonly string[]>
> = {
  identity: ["packages/ui/src/components/settings/IdentitySettingsSection.tsx"],
  "ai-model": [
    "packages/ui/src/components/settings/ProviderSwitcher.tsx",
    "packages/ui/src/components/settings/ProviderCard.tsx",
    "packages/ui/src/components/local-inference/RoutingMatrix.tsx",
  ],
  voice: [
    "packages/ui/src/components/settings/VoiceSectionMount.tsx",
    "packages/ui/src/components/settings/VoiceSection.tsx",
  ],
  capabilities: ["packages/ui/src/components/settings/CapabilitiesSection.tsx"],
  apps: ["packages/ui/src/components/settings/AppsManagementSection.tsx"],
  connectors: ["packages/ui/src/components/settings/ConnectorsSection.tsx"],
  runtime: ["packages/ui/src/components/settings/RuntimeSettingsSection.tsx"],
  appearance: [
    "packages/ui/src/components/settings/AppearanceSettingsSection.tsx",
  ],
  background: [
    "packages/ui/src/components/settings/BackgroundSettingsSection.tsx",
    "packages/ui/src/components/settings/BackgroundSettingsControls.tsx",
  ],
  "remote-plugins": [
    "packages/ui/src/components/settings/RemotePluginHostSection.tsx",
  ],
  "wallet-rpc": [
    "packages/ui/src/components/settings/WalletRpcSection.tsx",
    "packages/ui/src/components/settings/WalletKeysSection.tsx",
    "packages/ui/src/components/pages/ConfigPageView.tsx",
  ],
  updates: ["packages/ui/src/components/pages/ReleaseCenterView.tsx"],
  advanced: ["packages/ui/src/components/settings/AdvancedSection.tsx"],
  "app-permissions": [
    "packages/ui/src/components/settings/AppPermissionsSection.tsx",
  ],
  permissions: [
    "packages/ui/src/components/settings/PermissionsSection.tsx",
    "packages/ui/src/components/settings/permission-controls.tsx",
  ],
  secrets: [
    "packages/ui/src/components/settings/SecretsManagerSection.tsx",
    "packages/ui/src/components/settings/settings-agent-rows.tsx",
    "packages/ui/src/components/settings/VaultInventoryPanel.tsx",
  ],
  security: ["packages/ui/src/components/settings/SecuritySettingsSection.tsx"],
};

function readRepoFiles(files: readonly string[]): string {
  const missing = files.filter(
    (file) => !existsSync(path.join(REPO_ROOT, file)),
  );
  expect(missing, "owner files must exist").toEqual([]);
  return files
    .map((file) => readFileSync(path.join(REPO_ROOT, file), "utf8"))
    .join("\n");
}

function countAgentElements(source: string): number {
  return (
    (source.match(/useAgentElement(?:<[^>]*>)?\(/g)?.length ?? 0) +
    (source.match(/\sagent=\{?["'`][^"'`]+["'`]\}?/g)?.length ?? 0) +
    // Design-system agent-surface rows (`settings-agent-rows`,
    // `useAgentElement`-backed controls) declare their agent-addressable control
    // via an `agentId=` prop instead of a direct `useAgentElement(` call — a
    // section built entirely from those rows (e.g. CapabilitiesSection after the
    // design-system consolidation) is still fully agent-wired.
    (source.match(/\sagentId=\{?["'`][^"'`]+["'`]\}?/g)?.length ?? 0)
  );
}

describe("required core view agent-surface coverage", () => {
  it("tracks every required core view in the same list as view switching", () => {
    expect(Object.keys(CORE_SURFACE_OWNERS)).toEqual(REQUIRED_CORE_VIEW_IDS);
  });

  it("keeps shell-rendered required views wrapped in their live agent surface", () => {
    const missingShells: string[] = [];
    for (const [requiredId, owner] of Object.entries(CORE_SURFACE_OWNERS)) {
      if (owner.provider !== "shell") continue;
      const source = readRepoFiles(owner.files);
      if (
        !source.includes(`<ShellViewAgentSurface viewId="${owner.viewId}">`)
      ) {
        missingShells.push(`${requiredId} -> ${owner.viewId}`);
      }
    }
    expect(missingShells).toEqual([]);
  });

  it("keeps every required core view backed by agent-addressable controls", () => {
    const insufficient: string[] = [];
    for (const [requiredId, owner] of Object.entries(CORE_SURFACE_OWNERS)) {
      const source = readRepoFiles(owner.files);
      const agentElementCount = countAgentElements(source);
      if (agentElementCount < owner.minAgentElements) {
        insufficient.push(
          `${requiredId}: ${agentElementCount} < ${owner.minAgentElements}`,
        );
      }
    }
    expect(insufficient).toEqual([]);
  });

  it("keeps critical per-view agent ids stable for chat and voice targeting", () => {
    const missingSnippets: string[] = [];
    for (const [requiredId, owner] of Object.entries(CORE_SURFACE_OWNERS)) {
      if (!owner.requiredSnippets?.length) continue;
      const source = readRepoFiles(owner.files);
      for (const snippet of owner.requiredSnippets) {
        if (!source.includes(snippet)) {
          missingSnippets.push(`${requiredId}: ${snippet}`);
        }
      }
    }
    expect(missingSnippets).toEqual([]);
  });
});

describe("settings subsection agent-surface coverage", () => {
  it("tracks every canonical settings subsection", () => {
    expect(Object.keys(SETTINGS_SECTION_OWNER_FILES)).toEqual(
      REQUIRED_SETTINGS_SECTION_IDS,
    );
  });

  it("keeps settings subsection navigation registered as agent-addressable section ids", () => {
    const settingsView = readRepoFiles([
      "packages/ui/src/components/pages/SettingsView.tsx",
    ]);
    const sectionInterpolation = "$" + "{section.id}";
    expect(settingsView).toContain("useAgentElement<HTMLButtonElement>");
    expect(settingsView).toContain(`id: \`section-${sectionInterpolation}\``);
  });

  it("keeps every settings subsection owner wired to agent-surface controls", () => {
    const unwired: string[] = [];
    for (const [sectionId, files] of Object.entries(
      SETTINGS_SECTION_OWNER_FILES,
    )) {
      const source = readRepoFiles(files);
      if (countAgentElements(source) === 0) unwired.push(sectionId);
    }
    expect(unwired).toEqual([]);
  });
});
