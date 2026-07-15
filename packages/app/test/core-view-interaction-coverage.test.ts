/**
 * Unit tests for the Core View Interaction Coverage app shell contract and
 * coverage guardrail.
 */
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
const SCENARIO_PR_WORKFLOW = ".github/workflows/scenario-pr.yml";

type InteractionOwner = {
  spec: string;
  proves: string;
  signals: readonly string[];
};

type CoreViewInteraction = {
  owners: readonly InteractionOwner[];
};

const SETTINGS_CHAT_OWNER: InteractionOwner = {
  spec: "packages/app/test/ui-smoke/settings-chat-control.spec.ts",
  proves:
    "Lists every settings section's agent elements and proves agent-fill / agent-click mutate visible controls through the view-interact bridge.",
  signals: [
    "settings is fully chat-drivable",
    "every section exposes chat-addressable controls",
    "agent-fill",
    "agent-click",
    "unwiredControls",
  ],
};

const SHELL_AGENT_BRIDGE_OWNER: InteractionOwner = {
  spec: "packages/app/test/ui-smoke/shell-view-agent-bridge-inventory.spec.ts",
  proves:
    "Runtime-lists shell view controls through window.__ELIZA_BRIDGE__.viewInteract and proves representative fill/click mutations.",
  signals: [
    "shell views expose concrete chat/voice-drivable controls through the agent bridge",
    "Bridge-edited character bio.",
    "editor-mode-query",
  ],
};

const PLUGIN_AGENT_BRIDGE_OWNER: InteractionOwner = {
  spec: "packages/app/test/ui-smoke/plugin-view-agent-bridge-inventory.spec.ts",
  proves:
    "Runtime-lists plugin-backed app page controls and proves registered app-shell plugin click mutations.",
  signals: [
    "plugin views expose concrete chat/voice-drivable controls through the agent bridge",
    "registered app-shell plugin pages can be clicked through the bridge",
    "wallet.inventory",
  ],
};

const CORE_VIEW_INTERACTIONS: Readonly<Record<string, CoreViewInteraction>> = {
  knowledge: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/documents-view.spec.ts",
        proves:
          "Opens the Knowledge/Documents surface with upload, learned, and transcript provenance fixtures.",
        signals: ["Knowledge/Documents view", "DOCS_FIXTURE", "documents-view"],
      },
    ],
  },
  character: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/settings-sections-interactions.spec.ts",
        proves:
          "Runs the live-only character bio edit save->reload->read-back path against the real backend.",
        signals: [
          "character editor deep round-trip",
          "editing the bio saves through the real backend",
          "uniqueBio",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/character-editor.spec.ts",
        proves:
          "Runs the live-only CharacterHubView style-rule save->reload->read-back path against the real backend.",
        signals: [
          "style rule save returns 2xx and persists across reload",
          "style-add-input-all",
          "2xx PUT /api/character",
        ],
      },
    ],
  },
  settings: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      SETTINGS_CHAT_OWNER,
      {
        spec: "packages/app/test/ui-smoke/settings-sections-interactions.spec.ts",
        proves:
          "Drives representative settings controls through real UI events and backend requests.",
        signals: [
          "voice settings: the wake-word toggle flips state",
          "capabilities settings: the Wallet switch fires the real config write",
          "backup settings: Back Up opens its modal",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/settings-mobile-load.spec.ts",
        proves: "Opens every settings section at phone width without crashes.",
        signals: [
          "settings sections load at mobile width",
          "section root",
          "rendered an error boundary",
        ],
      },
    ],
  },
  tasks: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/task-coordinator-gui-interactions.spec.ts",
        proves:
          "Drives the CodingAgentTasksPanel used by the Tasks page: search, detail, sessions, artifacts, archive, and reopen.",
        signals: [
          "task coordinator GUI searches",
          "archiveRequests",
          "reopenRequests",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/task-widget-in-chat.spec.ts",
        proves:
          "Exercises task status widgets inside chat, the task workflow surface used by voice/chat task actions.",
        signals: ["chat task widget", "task-widget", "data-task-status"],
      },
    ],
  },
  automations: {
    owners: [
      {
        spec: "packages/app/test/ui-smoke/workflow-editor.spec.ts",
        proves:
          "Opens the Automations WorkflowEditor, saves a connected graph, and reloads the persisted definition.",
        signals: [
          "workflow editor saves a connected graph",
          "workflow save should receive a 2xx POST",
          "matrix smoke digest",
        ],
      },
    ],
  },
  orchestrator: {
    owners: [
      PLUGIN_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/orchestrator-gui-workbench.spec.ts",
        proves:
          "Drives orchestrator task creation, rail/timeline/inspector controls, messages, agent add, pause/resume, and plan restart routes.",
        signals: [
          "orchestrator-workbench",
          "orchestrator-add-agent-submit",
          "restartWithEditedPlanBodies",
        ],
      },
    ],
  },
  transcripts: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/transcript-realaudio.spec.ts",
        proves:
          "Runs the real-audio transcript browser path and verifies transcript UI output.",
        signals: ["live-meeting-page", "transcript", "real audio"],
      },
      {
        spec: "packages/ui/src/components/transcripts/TranscriptsView.test.tsx",
        proves:
          "Unit-drives transcript row selection, player controls, and empty state.",
        signals: ["transcript-row-t1", "transcript-play", "transcripts-empty"],
      },
    ],
  },
  wallet: {
    owners: [
      PLUGIN_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
        proves:
          "Exercises wallet refresh, sidebar tabs, token/NFT state, hide, and RPC settings navigation.",
        signals: [
          "wallet inventory interactions",
          "Hide USDC",
          "Open RPC settings",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/wallet-inventory.spec.ts",
        proves:
          "Exercises wallet chain badges, deterministic token rows, copy controls, NFT/DeFi tabs, and hidden-token persistence.",
        signals: [
          "wallet inventory exposes chain badges",
          "wallet-copy-evm-address",
          "wallet-token-hide-ethereum-native-usdc",
        ],
      },
    ],
  },
  browser: {
    owners: [
      {
        spec: "packages/app/test/ui-smoke/browser-workspace.spec.ts",
        proves:
          "Drives browser tab creation, address navigation, selected-tab switching, and closing every browser tab.",
        signals: [
          "browser workspace can create, navigate, switch, and close tabs",
          "browser-workspace-close-all-tabs",
          "browser-workspace-nav-new-tab",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/browser-skills-agent-bridge.spec.ts",
        proves:
          "Drives Browser controls through the agent view-interact bridge used by chat and voice.",
        signals: [
          "browser route is chat/voice-drivable through the agent bridge",
          "browser agent bridge exposes navigation controls",
          "agent-fill",
        ],
      },
    ],
  },
  files: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/files-view-crud.spec.ts",
        proves:
          "Deletes a file through confirm -> DELETE request -> optimistic removal.",
        signals: ["files view: delete a file", "file-delete", "DELETE request"],
      },
      {
        spec: "packages/app/test/ui-smoke/files-view.spec.ts",
        proves:
          "Mounts populated Files fixtures at desktop and mobile, including media rendering.",
        signals: [
          "Files view visual + smoke",
          "FILES_FIXTURE",
          "captureScreenshotWithQualityRetry",
        ],
      },
    ],
  },
  skills: {
    owners: [
      {
        spec: "packages/app/test/ui-smoke/apps-builtin-pages-interactions.spec.ts",
        proves:
          "Opens Skills, verifies empty state, and opens the New Skill create form.",
        signals: [
          "skills view shows empty state and New Skill opens the create form",
          "skills-shell",
          "create skill",
        ],
      },
      {
        spec: "packages/ui/src/components/pages/SkillsView.test.tsx",
        proves:
          "Unit-drives skill toggle, chat-backed search binding, and background refresh.",
        signals: [
          "toggling the selected skill's switch",
          "view→chat binding",
          "refreshSkills",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/browser-skills-agent-bridge.spec.ts",
        proves:
          "Drives Skills controls through the agent view-interact bridge used by chat and voice.",
        signals: [
          "skills route is chat/voice-drivable through the agent bridge",
          "skills agent bridge exposes create controls",
          "create-skill-name",
        ],
      },
    ],
  },
  feed: {
    owners: [
      PLUGIN_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/apps-personal-assistant-feed-interactions.spec.ts",
        proves:
          "Exercises the Feed GUI no-run state and command routing through deterministic interact routes.",
        signals: [
          "feed gui no-run state",
          "Feed route exposes reachable GUI state",
        ],
      },
    ],
  },
  relationships: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/apps-builtin-pages-interactions.spec.ts",
        proves:
          "Opens the built-in Relationships page and verifies graph/people data requests.",
        signals: [
          "relationships view loads the graph",
          "relationships-view",
          "relReqs",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts",
        proves:
          "Exercises the relationships graph and toggles an entity-kind filter in the decomposed view.",
        signals: [
          "relationships decomposed view",
          "toggles a kind filter",
          "/relationships",
        ],
      },
    ],
  },
  logs: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/apps-diagnostics-interactions.spec.ts",
        proves:
          "Filters logs through the chat composer, clears filters, and proves live-tail polling re-queries the backend.",
        signals: [
          "logs page search really filters entries",
          "clear restores them",
          "re-queries the log source",
        ],
      },
    ],
  },
  database: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/apps-builtin-pages-interactions.spec.ts",
        proves: "Opens Database, switches to SQL editor, and runs a query.",
        signals: [
          "database view loads tables and runs a SQL query",
          "queryReqs",
          "run query",
        ],
      },
      {
        spec: "packages/ui/src/components/pages/DatabaseView.test.tsx",
        proves:
          "Unit-drives table selection, row loading, empty table, and surfaced errors.",
        signals: [
          "loads rows when a table is selected",
          "surfaces a row-load error",
          "executeDatabaseQuery",
        ],
      },
    ],
  },
  trajectories: {
    owners: [
      SHELL_AGENT_BRIDGE_OWNER,
      {
        spec: "packages/app/test/ui-smoke/apps-model-training-interactions.spec.ts",
        proves:
          "Drives trajectory viewer refresh polling, phase filters, and selected detail changes.",
        signals: [
          "trajectory viewer route refreshes",
          "Showing 1 plan calls",
          "Beta response from Playwright trajectory fixture.",
        ],
      },
      {
        spec: "packages/app/test/ui-smoke/apps-builtin-pages-interactions.spec.ts",
        proves:
          "Opens Trajectories and proves chat-composer search re-queries the list.",
        signals: [
          "trajectories view loads and search re-queries",
          "trajectories-view",
          "smoke-query",
        ],
      },
    ],
  },
};

const SETTINGS_SECTION_INTERACTIONS: Readonly<
  Record<string, readonly InteractionOwner[]>
> = Object.fromEntries(
  REQUIRED_SETTINGS_SECTION_IDS.map((sectionId) => [
    sectionId,
    [
      SETTINGS_CHAT_OWNER,
      {
        spec: "packages/app/test/ui-smoke/settings-mobile-load.spec.ts",
        proves: `Loads settings section ${sectionId} at mobile width without crashes.`,
        signals: ["settings sections load at mobile width", "section.id"],
      },
    ],
  ]),
) as Record<string, readonly InteractionOwner[]>;

const SHELL_PROVIDER_BOUNDARY_SEGMENTS: readonly {
  file: string;
  start: string;
  end?: string;
}[] = [
  {
    file: "packages/ui/src/components/character/CharacterEditor.tsx",
    start: "export function CharacterEditor(",
    end: "/**\n * Re-export as CharacterView",
  },
  {
    file: "packages/ui/src/components/pages/SettingsView.tsx",
    start: "export function SettingsView(",
  },
  {
    file: "packages/ui/src/components/transcripts/TranscriptsView.tsx",
    start: "export function TranscriptsView(",
  },
  {
    file: "packages/ui/src/components/pages/BrowserWorkspaceView.tsx",
    start: "export function BrowserWorkspaceView(",
  },
  {
    file: "packages/ui/src/components/pages/FilesView.tsx",
    start: "export function FilesView(",
    end: "function FilesViewBody(",
  },
  {
    file: "packages/ui/src/components/pages/SkillsView.tsx",
    start: "function SkillsFullView(",
    end: "function SkillsFullViewContent(",
  },
  {
    file: "packages/ui/src/components/pages/LogsView.tsx",
    start: "export function LogsView(",
    end: "function LogsViewBody(",
  },
  {
    file: "packages/ui/src/components/pages/DatabasePageView.tsx",
    start: "export function DatabasePageView(",
  },
  {
    file: "packages/ui/src/components/pages/TrajectoriesView.tsx",
    start: "export function TrajectoriesView(",
  },
];

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function readSegment(
  source: string,
  startNeedle: string,
  endNeedle?: string,
): string {
  const start = source.indexOf(startNeedle);
  expect(start, `missing segment start ${startNeedle}`).toBeGreaterThanOrEqual(
    0,
  );
  const end = endNeedle ? source.indexOf(endNeedle, start + 1) : source.length;
  expect(end, `missing segment end ${endNeedle ?? "(eof)"}`).toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

function uiSmokeSpecName(spec: string): string | null {
  const match = spec.match(/^packages\/app\/test\/ui-smoke\/(.+\.spec\.ts)$/);
  return match?.[1] ?? null;
}

function uniqueOwners(owners: Iterable<InteractionOwner>): InteractionOwner[] {
  return [
    ...new Map(
      [...owners].map((owner) => [`${owner.spec}:${owner.proves}`, owner]),
    ).values(),
  ];
}

describe("core view interaction coverage", () => {
  it("tracks the exact required core-view inventory", () => {
    expect(Object.keys(CORE_VIEW_INTERACTIONS)).toEqual(REQUIRED_CORE_VIEW_IDS);
  });

  it("references real specs with declared coverage signals", () => {
    const owners = uniqueOwners(
      Object.values(CORE_VIEW_INTERACTIONS).flatMap(({ owners }) => owners),
    );
    const missingSpecs: string[] = [];
    const missingSignals: string[] = [];

    for (const owner of owners) {
      const absolutePath = path.join(REPO_ROOT, owner.spec);
      if (!existsSync(absolutePath)) {
        missingSpecs.push(owner.spec);
        continue;
      }
      const source = readRepoFile(owner.spec);
      const absent = owner.signals.filter((signal) => !source.includes(signal));
      if (absent.length > 0) {
        missingSignals.push(`${owner.spec}: ${absent.join(", ")}`);
      }
    }

    expect(missingSpecs).toEqual([]);
    expect(missingSignals).toEqual([]);
  });

  it("keeps Playwright ui-smoke interaction owners wired into scenario PR CI", () => {
    const workflow = readRepoFile(SCENARIO_PR_WORKFLOW);
    const unwired = uniqueOwners(
      Object.values(CORE_VIEW_INTERACTIONS).flatMap(({ owners }) => owners),
    )
      .map((owner) => uiSmokeSpecName(owner.spec))
      .filter((name): name is string => name !== null)
      .filter((name) => !workflow.includes(`test/ui-smoke/${name}`));

    expect(unwired).toEqual([]);
  });

  it("keeps shell view agent hooks under their ShellViewAgentSurface provider", () => {
    const inertHookRisks: string[] = [];
    for (const { file, start, end } of SHELL_PROVIDER_BOUNDARY_SEGMENTS) {
      const source = readRepoFile(file);
      const segment = readSegment(source, start, end);
      if (segment.includes("useAgentElement(")) {
        inertHookRisks.push(`${file}: ${start}`);
      }
    }

    expect(
      inertHookRisks,
      "useAgentElement hooks in the same component that returns ShellViewAgentSurface run before the provider exists; move hooks into a child rendered under the provider",
    ).toEqual([]);
  });
});

describe("settings subsection interaction coverage", () => {
  it("tracks the exact required settings-subsection inventory", () => {
    expect(Object.keys(SETTINGS_SECTION_INTERACTIONS)).toEqual(
      REQUIRED_SETTINGS_SECTION_IDS,
    );
  });

  it("keeps every subsection backed by chat-control and load evidence", () => {
    const missingSignals: string[] = [];
    for (const [sectionId, owners] of Object.entries(
      SETTINGS_SECTION_INTERACTIONS,
    )) {
      for (const owner of owners) {
        const source = readRepoFile(owner.spec);
        const absent = owner.signals.filter(
          (signal) => !source.includes(signal),
        );
        if (absent.length > 0) {
          missingSignals.push(
            `${sectionId} -> ${owner.spec}: ${absent.join(", ")}`,
          );
        }
      }
    }
    expect(missingSignals).toEqual([]);
  });
});
