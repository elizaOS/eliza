import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const VIEW_CASES_SOURCE = path.join(HERE, "ui-smoke", "plugin-view-cases.ts");
const KEYLESS_WORKFLOW = path.join(
  REPO_ROOT,
  ".github/workflows/scenario-pr.yml",
);

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

const DEFAULT_TUI_OWNER: InteractionOwner = {
  spec: "packages/agent/src/__tests__/plugin-tui-view-coverage.test.ts",
  proves:
    "Every bundled TUI declares terminal parity capabilities and dispatches get-state through the view interact route.",
  signals: ["can dispatch standard interactions", "TUI_PARITY_CAPABILITIES"],
};

const VISUAL_BASELINE_OWNER: InteractionOwner = {
  spec: "packages/app/test/ui-smoke/plugin-views-visual.spec.ts",
  proves:
    "Captures screenshots, audits rendered visible text/controls, and clicks every TUI terminal command.",
  signals: [
    "captureScreenshotWithQualityRetry",
    "visibleText",
    "data-terminal-command",
  ],
};

const GUI_INTERACTION_OWNERS: Readonly<
  Record<string, readonly InteractionOwner[]>
> = {
  companion: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Drives companion chat dock, emote picker, microphone toggles, and VRM canvas drag controls.",
      signals: [
        "companion interactions",
        "emote-picker",
        "companion-vrm-canvas",
      ],
    },
  ],
  contacts: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises Android contacts search, detail navigation, create form, and fixture persistence.",
      signals: [
        "contacts deterministic controls",
        "contacts-new",
        "contacts-search",
      ],
    },
  ],
  hyperliquid: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Refreshes market data and verifies markets, positions, and orders.",
      signals: ["hyperliquid refresh", "Markets", "Open orders"],
    },
  ],
  lifeops: [
    {
      spec: "packages/app/test/ui-smoke/apps-lifeops-feed-interactions.spec.ts",
      proves:
        "Exercises reminders, alarms, creation, snooze/complete flows, and deterministic LifeOps routes.",
      signals: [
        "LifeOps app supports deterministic reminders",
        "snoozeRequests",
      ],
    },
  ],
  messages: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises SMS role request, thread navigation, compose fields, send action, and fixture persistence.",
      signals: [
        "messages deterministic controls",
        "messages-send",
        "messages-compose-body",
      ],
    },
  ],
  "model-tester": [
    {
      spec: "packages/app/test/ui-smoke/apps-model-training-interactions.spec.ts",
      proves:
        "Runs deterministic text and image model probes through visible form controls.",
      signals: [
        "model tester route runs deterministic visible probes",
        "run text probe",
      ],
    },
  ],
  phone: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises dialer keypad, backspace, call action, recent calls, and native fixture persistence.",
      signals: [
        "phone deterministic controls",
        "phone-dial-key",
        "phone-dial-call",
      ],
    },
  ],
  polymarket: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Refreshes markets and exercises market selection/order detail UI.",
      signals: ["Polymarket refresh", "fixture market selection"],
    },
  ],
  shopify: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises products, create product dialog, orders, inventory, customers, and search controls.",
      signals: ["Shopify create product", "Shopify inventory increase"],
    },
  ],
  steward: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises approval refresh, approve/reject flows, rejection reason, history filters, and table state.",
      signals: [
        "steward interactions",
        "Confirm Reject",
        "Transaction History",
      ],
    },
  ],
  vincent: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises refresh, connected wallet/trading state, and disconnect flow.",
      signals: ["vincent interactions", "Disconnect", "Vincent Trading Agent"],
    },
  ],
  wallet: [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises wallet refresh, sidebar tabs, NFT/token state, swap, hide, and RPC settings navigation.",
      signals: [
        "wallet inventory interactions",
        "Swap USDC",
        "Open RPC settings",
      ],
    },
  ],
  "vector-browser": [
    {
      spec: "packages/app/test/ui-smoke/apps-utility-interactions.spec.ts",
      proves:
        "Exercises vector memory search, list/detail state, and 2D/3D projection mode controls.",
      signals: ["vector browser controls", "vector 2D projection"],
    },
  ],
  feed: [
    {
      spec: "packages/app/test/ui-smoke/apps-lifeops-feed-interactions.spec.ts",
      proves:
        "Exercises feed GUI no-run state and TUI command routing through deterministic interact routes.",
      signals: ["feed gui no-run state", "feed tui"],
    },
  ],
  "views-manager": [
    {
      spec: "packages/app/test/ui-smoke/view-manager-actual-flow.spec.ts",
      proves:
        "Exercises dynamic view create, update, switch/open, remote bundle request, and delete flows.",
      signals: [
        "creates, updates, switches, opens, and deletes",
        "registerCalls",
      ],
    },
  ],
  clawville: [
    {
      spec: "packages/app/test/ui-smoke/game-apps.spec.ts",
      proves:
        "Launches the game app, validates viewer load, command buttons, and chat message flow.",
      signals: ["clawville", "clawville-command", "chatContent"],
    },
  ],
  "defense-of-the-agents": [
    {
      spec: "packages/app/test/ui-smoke/game-apps.spec.ts",
      proves:
        "Launches the game app, validates viewer load, command buttons, and chat message flow.",
      signals: ["defense-of-the-agents", "defense-command", "chatContent"],
    },
  ],
  "2004scape": [
    {
      spec: "packages/app/test/ui-smoke/game-operator-gui-interactions.spec.ts",
      proves:
        "Launches the operator game app, validates viewer load, suggested prompts, control routes, and chat message flow.",
      signals: ["2004scape-live-operator-surface", "controlAction"],
    },
  ],
  hyperscape: [
    {
      spec: "packages/app/test/ui-smoke/game-operator-gui-interactions.spec.ts",
      proves:
        "Launches the Hyperscape host, validates viewer load, diagnostics, and the exposed session-control route.",
      signals: ["hostOnly", "game-session-control", "controlAction"],
    },
  ],
  scape: [
    {
      spec: "packages/app/test/ui-smoke/game-operator-gui-interactions.spec.ts",
      proves:
        "Launches the operator game app, validates viewer load, suggested prompts, control routes, and chat message flow.",
      signals: ["scape-live-operator-surface", "controlAction"],
    },
  ],
  orchestrator: [
    {
      spec: "packages/app/test/ui-smoke/orchestrator-gui-workbench.spec.ts",
      proves:
        "Exercises empty state, create task form, POST body, task rail/detail, composer, and message send.",
      signals: ["orchestrator-create-submit", "orchestrator-send"],
    },
  ],
  screenshare: [
    {
      spec: "packages/app/test/ui-smoke/screenshare-gui-interactions.spec.ts",
      proves:
        "Exercises host start/open/copy/stop, remote connect, capability refresh, and request payloads.",
      signals: ["host lifecycle", "Refresh capabilities", "screen-token-1"],
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
      proves:
        "Exercises trajectory refresh, detail selection, stage filtering, and search.",
      signals: ["trajectory viewer route refreshes", "trajectory refresh"],
    },
  ],
  training: [
    {
      spec: "packages/app/test/ui-smoke/apps-model-training-interactions.spec.ts",
      proves:
        "Exercises trajectory selection, dataset build, training job start, and cancel flow.",
      signals: ["fine-tuning route selects trajectories", "start training job"],
    },
  ],
  facewear: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises device status refresh and deterministic manage bridge behavior.",
      signals: ["facewear device controls", "facewearStatusRequests"],
    },
  ],
  smartglasses: [
    {
      spec: "packages/app/test/ui-smoke/apps-comms-device-interactions.spec.ts",
      proves:
        "Exercises connect headset, display writes, microphone toggles, and Wi-Fi setup bridge calls.",
      signals: ["smartglasses bridge controls", "Connect Headset"],
    },
  ],
};

const INTERACTION_DEBT: Readonly<Record<string, string>> = {};

const MAX_INTERACTION_DEBT = 0;

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
      /\["([^"]+)",\s*"(gui|tui)",\s*"([^"]+)"(?:,\s*\{[^}\]]*\})?\]/g,
    ),
  ).flatMap((caseMatch) => {
    const id = caseMatch[1];
    const viewType = caseMatch[2];
    const viewPath = caseMatch[3];
    if (!id || (viewType !== "gui" && viewType !== "tui") || !viewPath) {
      return [];
    }
    return [{ id, viewType, path: viewPath }];
  });
}

function interactionOwners(view: VisualViewCase): readonly InteractionOwner[] {
  if (view.viewType === "tui") {
    return [VISUAL_BASELINE_OWNER, DEFAULT_TUI_OWNER];
  }
  return [VISUAL_BASELINE_OWNER, ...(GUI_INTERACTION_OWNERS[view.id] ?? [])];
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function uiSmokeSpecName(spec: string): string | null {
  const match = spec.match(/^packages\/app\/test\/ui-smoke\/(.+\.spec\.ts)$/);
  return match?.[1] ?? null;
}

describe("plugin view interaction coverage", () => {
  it("classifies every visual-matrix view as interaction-covered or explicit debt", () => {
    const visualCases = readVisualMatrixCases();
    const unclassified = visualCases.filter((view) => {
      const owners = interactionOwners(view);
      const hasInteractionOwner =
        owners.some((owner) => owner !== VISUAL_BASELINE_OWNER) ||
        view.viewType === "tui";
      return !hasInteractionOwner && !(viewKey(view) in INTERACTION_DEBT);
    });

    expect(visualCases.length).toBe(53);
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

  it("keeps ui-smoke interaction-owner specs wired into keyless CI", () => {
    const owners = new Map<string, InteractionOwner>();
    for (const view of readVisualMatrixCases()) {
      for (const owner of interactionOwners(view)) {
        owners.set(owner.spec, owner);
      }
    }

    const workflow = readFileSync(KEYLESS_WORKFLOW, "utf8");
    const unwired = [...owners.keys()]
      .map((spec) => ({
        spec,
        uiSmokeName: uiSmokeSpecName(spec),
      }))
      .filter(
        (owner): owner is { spec: string; uiSmokeName: string } =>
          owner.uiSmokeName !== null,
      )
      .filter(
        (owner) => !workflow.includes(`test/ui-smoke/${owner.uiSmokeName}`),
      )
      .map((owner) => owner.spec);

    expect(
      unwired,
      "Every Playwright ui-smoke interaction owner must run in keyless scenario-pr CI.",
    ).toEqual([]);
  });
});
