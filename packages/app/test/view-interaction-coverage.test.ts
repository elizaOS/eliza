/**
 * Unit tests for the View Interaction Coverage app shell contract and coverage
 * guardrail.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const VIEW_CASES_SOURCE = path.join(HERE, "ui-smoke", "plugin-view-cases.ts");

type ViewType = "gui" | "tui";

type VisualViewCase = {
  id: string;
  viewType: ViewType;
  path: string;
};

type InteractionOwner = {
  spec: string;
  proves: string;
  signals: readonly string[];
};

const VISUAL_BASELINE_OWNER: InteractionOwner = {
  spec: "packages/app/test/ui-smoke/plugin-views-visual.spec.ts",
  proves:
    "Captures screenshots and audits rendered visible text/controls for every shipped plugin view.",
  signals: ["captureScreenshotWithQualityRetry", "visibleText"],
};

const DECOMPOSED_PA_SPEC =
  "packages/app/test/ui-smoke/apps-personal-assistant-decomposed-interactions.spec.ts";

const GUI_INTERACTION_OWNERS: Readonly<
  Record<string, readonly InteractionOwner[]>
> = {
  calendar: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Drives the calendar day/week/month tab switcher.",
      signals: ["calendar decomposed view", "/calendar"],
    },
  ],
  finances: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the finances summary scaffold.",
      signals: ["finances decomposed view", "/finances"],
    },
  ],
  focus: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the focus/blocker scaffold.",
      signals: ["focus decomposed view", "/focus"],
    },
  ],
  goals: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the goals scaffold.",
      signals: ["goals decomposed view", "/goals"],
    },
  ],
  health: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the health regions.",
      signals: ["health decomposed view", "/health"],
    },
  ],
  inbox: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Toggles the inbox channel filters.",
      signals: ["inbox decomposed view", "/inbox"],
    },
  ],
  relationships: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves:
        "Renders the relationships knowledge graph and toggles an entity-kind filter.",
      signals: ["relationships decomposed view", "/relationships"],
    },
  ],
  todos: [
    {
      spec: DECOMPOSED_PA_SPEC,
      proves: "Renders the todo lanes.",
      signals: ["todos decomposed view", "/todos"],
    },
  ],
  contacts: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises the Android contacts create form and fixture persistence.",
      signals: [
        "contacts deterministic controls",
        "contacts-create-display-name",
        "contacts-create-submit",
      ],
    },
  ],
  cloud: [
    {
      spec: "plugins/plugin-elizacloud/src/components/cloud/CloudView.test.tsx",
      proves:
        "Exercises loading, signed-out, error/retry, ready account data, and designed section-level degradation for the Cloud account view.",
      signals: [
        "CloudView state-machine suite",
        "cloud-credit-balance",
        "Connect your Eliza Cloud account",
      ],
    },
  ],
  "computer-use-sessions": [
    {
      spec: "plugins/plugin-computeruse/src/views/ComputerUseSessionsView.test.tsx",
      proves:
        "Exercises authenticated session/frame rendering, virtual cursors, native floating-window intent, close-session mutation, and retryable failures.",
      signals: [
        "renders independent targets, a frame, and a virtual cursor",
        "requests a native always-on-top viewer",
        "keeps list failures distinct and retryable",
      ],
    },
  ],
  "lifeops-live-test": [
    {
      spec: "plugins/plugin-scheduling/src/components/lifeops-live-test/LifeOpsLiveTestSpatialView.tsx",
      proves:
        "Owns the LifeOps live-test readiness, run, retry, and fire-now agent controls consumed by the visual matrix.",
      signals: ["run-reminder", "run-checkin", "retry"],
    },
  ],
  messages: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises rendered SMS history, compose fields, send action, and fixture persistence.",
      signals: [
        "messages deterministic controls",
        "messages-send",
        "messages-body",
      ],
    },
  ],
  notes: [
    {
      spec: "plugins/plugin-notes/src/views/notes.e2e.test.tsx",
      proves:
        "Creates, edits, and preserves a note through the real Notes surface and filesystem-backed service.",
      signals: [
        "projects note mutations across read-only view remounts",
        "Demo briefing ready",
      ],
    },
  ],
  phone: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises the dialer keypad, contact dialing, call action, and native fixture persistence.",
      signals: ["phone deterministic controls", "dialpad-", "dialer-call"],
    },
  ],
  wallet: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises wallet refresh, sidebar tabs, NFT/token state, hide, and RPC settings navigation.",
      signals: [
        "wallet inventory interactions",
        "Hide USDC",
        "Wallet RPC settings action",
        'name: "RPC settings", exact: true',
      ],
    },
  ],
  "views-manager": [
    // The standalone 'Dynamic view management' form (and its
    // view-manager-actual-flow spec) left with the springboard->launcher
    // curation, and #11523 then made the launcher a read-only single page
    // (no edit mode, no drag-to-reorder, no pin/delete affordances). View
    // management now lives in the registered plugin-view lifecycle. Residual
    // gap: an e2e for CREATING a dynamic view through the current product flow.
    {
      spec: "packages/ui/src/components/pages/__e2e__/run-launcher-e2e.mjs",
      proves:
        "The read-only launcher (the surface that replaced the dynamic-view manager form): real tap-launch with telemetry, a stationary long-press that must NOT enter any edit mode, and the swipe-home rail gesture.",
      signals: [
        "a long-press never enters edit mode",
        "telemetry ring recorded the tap launch",
      ],
    },
    {
      spec: "packages/app/test/ui-smoke/plugin-views-lifecycle.spec.ts",
      proves:
        "Registered plugin views load, unmount, reopen, and reload cleanly across the view lifecycle.",
      signals: [
        "registered plugin view lifecycle",
        "loads, unmounts, reopens, and reloads",
      ],
    },
  ],
  orchestrator: [
    {
      spec: "packages/app/test/ui-smoke/orchestrator-gui-workbench.spec.ts",
      proves:
        "Exercises the read-only empty workbench and the rich build-room rail/timeline/inspector controls plus the add-agent form submit. (The GUI create-task/composer affordances moved to chat in the overlay-only redesign.)",
      signals: ["orchestrator-workbench", "orchestrator-add-agent-submit"],
    },
  ],
  "task-coordinator": [
    {
      spec: "packages/app/test/ui-smoke/task-coordinator-gui-interactions.spec.ts",
      proves:
        "Exercises task-thread search, detail expansion, sessions, artifacts, pending input, archive, and reopen flows.",
      signals: [
        "task coordinator GUI searches",
        "archiveRequests",
        "reopenRequests",
      ],
    },
  ],
  "trajectory-logger": [
    {
      spec: "packages/app/test/ui-smoke/apps-model-training-interactions.spec.ts",
      proves: "Exercises detail selection, stage filtering, and search.",
      signals: ["trajectory viewer route refreshes"],
    },
  ],
  cockpit: [
    {
      spec: "plugins/plugin-task-coordinator/src/CockpitRoute.test.tsx",
      proves:
        "Exercises the developer-only cockpit route through spawn wiring and deck/session-pane navigation.",
      signals: [
        "CockpitRoute — live spawn wiring",
        "spawning creates the task AND spawns the agent",
      ],
    },
  ],
};

// Every decomposed personal-assistant view has a dedicated interaction owner
// (apps-personal-assistant-decomposed-interactions.spec.ts) EXCEPT "documents":
// its `/documents` view path collides with the built-in "documents" tab
// (App.tsx findView matches `/${tab}`), so registering it in the ui-smoke stub
// hijacks the `/character/documents` route. It stays tracked debt until that
// view path is disambiguated.
const INTERACTION_DEBT: Readonly<Record<string, string>> = {
  "documents:gui":
    "The decomposed documents view path `/documents` collides with the built-in " +
    "`documents` tab (/character/documents) via App.tsx findView, so it cannot be " +
    "registered in the ui-smoke stub without hijacking that route. Needs a " +
    "disambiguated view path before a keyless interaction spec can drive it.",
};

const MAX_INTERACTION_DEBT = 1;

function viewKey(view: Pick<VisualViewCase, "id" | "viewType">) {
  return `${view.id}:${view.viewType}`;
}

function readVisualMatrixCases(): VisualViewCase[] {
  const source = readFileSync(VIEW_CASES_SOURCE, "utf8");
  const match = source.match(
    /const VIEW_CASES: ViewCase\[] = \(?\s*\[([\s\S]*?)\]\s*(?:satisfies[\s\S]*?)?\)?\s*\.map/,
  );
  expect(match?.[1], "VIEW_CASES declaration was not found").toBeTruthy();
  const viewCasesSource = match?.[1] ?? "";

  return Array.from(
    viewCasesSource.matchAll(
      /\["([^"]+)",\s*"(gui|tui|xr)",\s*"([^"]+)"(?:,\s*\{[^}\]]*\})?\]/g,
    ),
  ).flatMap((caseMatch) => {
    const id = caseMatch[1];
    const viewType = caseMatch[2];
    const viewPath = caseMatch[3];
    expect(
      viewType,
      `Plugin visual matrix must stay GUI-only; remove ${id}:${viewType} from VIEW_CASES`,
    ).toBe("gui");
    if (!id || viewType !== "gui" || !viewPath) {
      return [];
    }
    return [{ id, viewType, path: viewPath }];
  });
}

function interactionOwners(view: VisualViewCase): readonly InteractionOwner[] {
  return [VISUAL_BASELINE_OWNER, ...(GUI_INTERACTION_OWNERS[view.id] ?? [])];
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("plugin view interaction coverage", () => {
  it("classifies every visual-matrix view as interaction-covered or explicit debt", () => {
    const visualCases = readVisualMatrixCases();
    const unclassified = visualCases.filter((view) => {
      const owners = interactionOwners(view);
      const hasInteractionOwner = owners.some(
        (owner) => owner !== VISUAL_BASELINE_OWNER,
      );
      return !hasInteractionOwner && !(viewKey(view) in INTERACTION_DEBT);
    });

    expect(visualCases.length).toBe(22);
    expect(
      unclassified.map((view) => `${viewKey(view)} ${view.path}`),
      "Add an interaction owner or an explicit debt reason for each view case.",
    ).toEqual([]);
  });

  it("keeps the explicit interaction-debt bucket from growing", () => {
    const visualKeys = new Set(readVisualMatrixCases().map(viewKey));
    const debtKeys = Object.keys(INTERACTION_DEBT);
    const staleDebt = debtKeys.filter((key) => !visualKeys.has(key));
    const coveredDebt = readVisualMatrixCases()
      .filter((view) => viewKey(view) in INTERACTION_DEBT)
      .filter((view) =>
        interactionOwners(view).some(
          (owner) => owner !== VISUAL_BASELINE_OWNER,
        ),
      )
      .map(viewKey);

    expect(debtKeys.length).toBeLessThanOrEqual(MAX_INTERACTION_DEBT);
    expect(staleDebt, "Remove debt entries for deleted/renamed views.").toEqual(
      [],
    );
    expect(
      coveredDebt,
      "These views now have interaction owners; remove them from INTERACTION_DEBT and lower MAX_INTERACTION_DEBT.",
    ).toEqual([]);
  });

  it("references real owner specs with the declared coverage signals", () => {
    const owners = new Map<string, InteractionOwner>();
    for (const view of readVisualMatrixCases()) {
      for (const owner of interactionOwners(view)) {
        owners.set(`${owner.spec}:${owner.proves}`, owner);
      }
    }

    const missingSpecs: string[] = [];
    const missingSignals: string[] = [];
    for (const owner of owners.values()) {
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
});
