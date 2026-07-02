// Extended runtime bridge inventory for the plugin-backed app pages that the
// original `plugin-view-agent-bridge-inventory.spec.ts` did NOT cover
// (#11356). The sibling spec drives only `wallet.inventory`, `orchestrator`,
// and `feed`; #10722 enumerates ~16 more instrumented plugin views that chat /
// voice must be able to address through `window.__ELIZA_VIEW_INTERACT__`.
//
// This spec mirrors the established pattern EXACTLY: it opens each real view
// through the preview harness, waits for the agent bridge, and asserts that
// `list-elements` returns the concrete id/role/label/fillable/clickable shape
// for the view's known controls against the REAL rendered DOM. It also
// generalizes the `unwiredControls` scan from `settings-chat-control.spec.ts`:
// any CONTROL-role element that renders without a `data-agent-id` (on itself or
// an ancestor) is a real "chat can't reach this control" gap and fails.
//
// Coverage / honest accounting (see the PR body for the full table):
//   Covered here: calendar, contacts, phone, messages, health, finances,
//     inbox, goals, todos, polymarket, hyperliquid, training, screenshare,
//     shopify, vector-browser (15).
//   Skipped: facewear — its GUI config moved to Settings → Wearables; the
//     standalone `facewear` view now declares only `modalities: ["xr","tui"]`
//     (plugins/plugin-facewear/src/index.ts) and `visibleInManager: false`, so
//     there is no GUI route that mounts an agent-bridge surface to inventory.
//     Its XR/TUI surfaces are exercised by the plugin's own view tests.
//
// The fixture backends for every view below already live in
// `installDefaultAppRoutes` (helpers.ts) — this spec adds NO new stubs; it only
// reuses the deterministic keyless smoke data the other decomposed-view specs
// already rely on.

import { expect, type Page, test } from "@playwright/test";
import {
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

interface AgentElement {
  id: string;
  role: string;
  label: string;
  status?: string;
  value?: unknown;
  fillable: boolean;
  clickable: boolean;
}

declare global {
  interface Window {
    __ELIZA_VIEW_INTERACT__?: (
      viewId: string,
      viewType: string,
      capability: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>;
  }
}

type ReadyMarker =
  | { testId: string }
  | { text: string | RegExp }
  | { selector: string };

type PluginViewTarget = {
  /** Human label for assertion messages + the coverage table. */
  label: string;
  /** App route the view mounts at. */
  path: string;
  /** view-interact viewId (matches the registered plugin view / route id). */
  viewId: string;
  /**
   * Optional render-ready anchor. When omitted, readiness is proven purely by
   * the agent bridge exposing `requiredIds` (the ids only register once the
   * view has mounted), which is the same contract `list-elements` asserts.
   */
  ready?: ReadyMarker;
  /**
   * Concrete `data-agent-id`s the view exposes through the bridge in the
   * deterministic keyless fixture state. Every id is a stable, always-rendered
   * control (a toolbar action, nav control, or a control keyed off a fixture
   * row that helpers.ts always serves) — never a control gated on live state.
   */
  requiredIds: readonly string[];
};

// Ordered roughly by surface family (comms → lifeops → markets → tooling) so a
// failure localizes to a cohesive group.
const PLUGIN_VIEW_TARGETS: readonly PluginViewTarget[] = [
  // --- Comms surfaces (plugin-phone / plugin-contacts / plugin-messages) ---
  {
    label: "Phone",
    path: "/phone",
    viewId: "phone",
    // phone-refresh + phone-call are declared unconditionally in the PhoneView
    // body (useAgentElement), so both register on mount regardless of data.
    requiredIds: ["phone-refresh", "phone-call"],
  },
  {
    label: "Contacts",
    path: "/contacts",
    viewId: "contacts",
    ready: { testId: "contacts-shell" },
    // Default mode is "list": nav-back + action-new render on mount.
    requiredIds: ["nav-back", "action-new"],
  },
  {
    label: "Messages",
    path: "/messages",
    viewId: "messages",
    // messages-refresh + messages-send are unconditional useAgentElement
    // controls in the MessagesView body.
    requiredIds: ["messages-refresh", "messages-send"],
  },
  // --- LifeOps decomposed views (spatial `Button agent=…` + DomSection ids) ---
  {
    label: "Calendar",
    path: "/calendar",
    viewId: "calendar",
    // The calendar mock (installDefaultAppRoutes) seeds "Design sync"; the
    // CalendarSection period-nav + view-mode controls always render.
    ready: { text: "Design sync" },
    requiredIds: [
      "calendar-prev",
      "calendar-today",
      "calendar-next",
      "calendar-new-event",
      "calendar-view-mode",
    ],
  },
  {
    label: "Inbox",
    path: "/inbox",
    viewId: "inbox",
    // Populated inbox fixture → gmail + discord messages. The channel-filter
    // chips render for EVERY INBOX_CHANNEL (not just channels with messages),
    // and the populated triage rows expose `open:<id>`.
    ready: { text: "Invoice #42 overdue" },
    requiredIds: [
      "inbox-channel-gmail",
      "inbox-channel-discord",
      "open:gmail:smoke-1",
    ],
  },
  {
    label: "Finances",
    path: "/finances",
    viewId: "finances",
    // Populated money fixtures → 1 transaction (tx-1) + 1 recurring (netflix).
    ready: { text: "Transactions (1)" },
    requiredIds: [
      "txn-tx-1",
      "open-txn-tx-1",
      "bill-netflix",
      "open-bill-netflix",
    ],
  },
  {
    label: "Goals",
    path: "/goals",
    viewId: "goals",
    // Populated goals fixture → 1 active + 1 paused goal, so the active/paused
    // status-filter chips both render.
    ready: { text: "Run a half marathon" },
    requiredIds: ["filter:active", "filter:paused"],
  },
  {
    label: "Todos",
    path: "/todos",
    viewId: "todos",
    // Populated todos fixture → Today / Upcoming / Someday each with one item.
    ready: { text: "Today (1)" },
    requiredIds: [
      "todo-todo-smoke-1",
      "todo-todo-smoke-2",
      "todo-todo-smoke-3",
    ],
  },
  {
    label: "Health",
    path: "/health",
    viewId: "health",
    // Populated sleep fixtures land HealthView on its "ready" branch (Last
    // sleep / Regularity / Baseline sections). Health rows carry data-derived
    // labels (`row-<label>`), so this view is asserted via the generalized
    // unwiredControls scan + a "has ≥1 bridged element" check rather than fixed
    // ids — see runInventory's `dataDriven` branch.
    ready: { text: "Last sleep" },
    requiredIds: [],
  },
  // --- Markets / connector surfaces (own view components, agent toolbars) ---
  {
    label: "Hyperliquid",
    path: "/hyperliquid",
    viewId: "hyperliquid",
    ready: { selector: '[aria-label="Hyperliquid controls"]' },
    requiredIds: ["hyperliquid-refresh", "hyperliquid-home"],
  },
  {
    label: "Polymarket",
    path: "/polymarket",
    viewId: "polymarket",
    ready: { selector: '[aria-label="Polymarket controls"]' },
    requiredIds: ["polymarket-refresh"],
  },
  {
    label: "Shopify",
    path: "/shopify",
    viewId: "shopify",
    ready: { selector: '[aria-label="Shopify controls"]' },
    requiredIds: ["shopify-refresh", "shopify-product-search"],
  },
  {
    label: "Screenshare",
    path: "/screenshare",
    viewId: "screenshare",
    ready: { text: /^Session:/ },
    requiredIds: ["screenshare-session-toggle", "screenshare-refresh"],
  },
  // --- Tooling views ---
  {
    label: "Training (fine-tuning)",
    path: "/apps/fine-tuning",
    viewId: "training",
    ready: { testId: "fine-tuning-view" },
    // The dataset / job sections mount together (not tab-gated) in FineTuningView,
    // so their refresh + build/start controls always register.
    requiredIds: [
      "dataset-refresh",
      "dataset-build",
      "job-refresh",
      "job-start",
    ],
  },
  {
    label: "Vector Browser",
    path: "/vector-browser",
    viewId: "vector-browser",
    // The vector toolbar controls (table select, view tabs, search) register on
    // mount; the memories table fixture keeps the list tab populated.
    requiredIds: [
      "vector-table",
      "vector-view-list",
      "vector-search",
      "vector-search-run",
    ],
  },
];

async function waitForReady(page: Page, marker: ReadyMarker): Promise<void> {
  if ("testId" in marker) {
    await expect(page.getByTestId(marker.testId)).toBeVisible({
      timeout: 60_000,
    });
    return;
  }
  if ("selector" in marker) {
    await expect(page.locator(marker.selector).first()).toBeVisible({
      timeout: 60_000,
    });
    return;
  }
  await expect(page.getByText(marker.text).first()).toBeVisible({
    timeout: 60_000,
  });
}

async function waitForAgentBridge(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => typeof window.__ELIZA_VIEW_INTERACT__ === "function",
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function interact(
  page: Page,
  viewId: string,
  capability: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return page.evaluate(
    async ({ viewId, capability, params }) => {
      const bridge = window.__ELIZA_VIEW_INTERACT__;
      if (!bridge) throw new Error("view-interact bridge not installed");
      return bridge(viewId, "gui", capability, params);
    },
    { viewId, capability, params },
  );
}

async function listAgentElements(
  page: Page,
  viewId: string,
): Promise<AgentElement[]> {
  return (await interact(page, viewId, "list-elements")) as AgentElement[];
}

async function expectAgentIds(
  page: Page,
  viewId: string,
  expectedIds: readonly string[],
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => (await listAgentElements(page, viewId)).map(({ id }) => id),
      {
        message: `${label} exposes ${expectedIds.join(", ")} through the agent bridge`,
        timeout: 30_000,
      },
    )
    .toEqual(expect.arrayContaining([...expectedIds]));
}

/** Every listed element must carry the well-formed agent-element contract. */
function assertElementShape(elements: AgentElement[], label: string): void {
  for (const el of elements) {
    expect(
      typeof el.id === "string" && el.id.length > 0,
      `${label}: element id must be a non-empty string (${JSON.stringify(el)})`,
    ).toBe(true);
    expect(
      typeof el.role === "string" && el.role.length > 0,
      `${label}: element ${el.id} must declare a role`,
    ).toBe(true);
    expect(
      typeof el.label === "string",
      `${label}: element ${el.id} must declare a string label`,
    ).toBe(true);
    expect(
      typeof el.fillable === "boolean",
      `${label}: element ${el.id} must declare a boolean fillable`,
    ).toBe(true);
    expect(
      typeof el.clickable === "boolean",
      `${label}: element ${el.id} must declare a boolean clickable`,
    ).toBe(true);
  }
}

/**
 * Generalized `unwiredControls` scan (from settings-chat-control.spec.ts): every
 * interactive CONTROL rendered inside the mounted view region that has no
 * `data-agent-id` on itself or an ancestor is a real "chat can't reach this"
 * gap. There is no single DOM wrapper attribute for a plugin view surface, so
 * the scan scopes to the tightest region that actually contains the view's
 * bridged controls: the nearest common ancestor of every `[data-agent-id]`
 * node. Shell chrome (nav rail, tab bar, hidden chat composer) lives outside
 * that subtree, so it is excluded without an allowlist; genuinely-unwired
 * controls rendered ALONGSIDE the view's wired controls are still caught.
 * Empty/absent sections contribute nothing, so this is robust to keyless data.
 */
async function scanUnwiredControls(page: Page, label: string): Promise<void> {
  const unwired = await page.evaluate(() => {
    const agentNodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-agent-id]"),
    ).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    });
    if (agentNodes.length === 0) return [] as string[];

    // Nearest common ancestor of all visible bridged nodes = the view region.
    let scope: HTMLElement = agentNodes[0];
    for (const node of agentNodes.slice(1)) {
      while (scope && !scope.contains(node)) {
        scope = scope.parentElement as HTMLElement;
        if (!scope) break;
      }
      if (!scope) break;
    }
    const root: HTMLElement =
      scope ?? document.getElementById("root") ?? document.body;

    const selector =
      'button:not([disabled]), [role="button"], input:not([type="hidden"]):not([disabled]):not([readonly]), textarea:not([disabled]), [role="switch"], [role="combobox"], [role="tab"], select:not([disabled])';
    const gaps: string[] = [];
    for (const el of Array.from(root.querySelectorAll(selector))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // not visible
      // Radix + native form-compat machinery renders aria-hidden mirror
      // controls; the addressable control is the visible trigger. Skip those.
      if (el.closest('[aria-hidden="true"]')) continue;
      if (!el.closest("[data-agent-id]")) {
        const role = el.getAttribute("role");
        const aria = el.getAttribute("aria-label");
        gaps.push(
          `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${
            aria ? `(${aria})` : ""
          }`,
        );
      }
    }
    // De-dupe so a repeated pattern reports once.
    return Array.from(new Set(gaps));
  });

  expect(
    unwired,
    `${label}: CONTROL-role elements not reachable from chat (no data-agent-id): ${unwired.join("; ")}`,
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await hideContinuousChatOverlay(page);
  await installDefaultAppRoutes(page);
});

for (const target of PLUGIN_VIEW_TARGETS) {
  test(`${target.label} exposes chat/voice-drivable controls through the agent bridge`, async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await openAppPath(page, target.path);
    if (target.ready) await waitForReady(page, target.ready);
    await waitForAgentBridge(page);

    if (target.requiredIds.length > 0) {
      // list-elements returns the view's concrete controls with correct
      // id/role/label/fillable/clickable against the REAL rendered view.
      await expectAgentIds(
        page,
        target.viewId,
        target.requiredIds,
        target.label,
      );
    } else {
      // Data-driven view (e.g. Health): assert the bridge exposes at least one
      // real control, rather than a fragile fixed id keyed off fixture values.
      await expect
        .poll(
          async () => (await listAgentElements(page, target.viewId)).length,
          {
            message: `${target.label} exposes ≥1 bridged control`,
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(0);
    }

    const elements = await listAgentElements(page, target.viewId);
    assertElementShape(elements, target.label);

    // A CONTROL rendered without data-agent-id fails, per the issue.
    await scanUnwiredControls(page, target.label);
  });
}

test("facewear has no GUI agent-bridge surface to inventory (documented skip)", async ({
  page,
}) => {
  // Not a coverage gap: plugins/plugin-facewear/src/index.ts declares the
  // standalone facewear view with `modalities: ["xr","tui"]` and
  // `visibleInManager: false` — its GUI config was moved to Settings →
  // Wearables (register.ts). There is no GUI route that mounts an agent-bridge
  // surface for `facewear`, so it is intentionally excluded from the inventory
  // above. This test documents that decision so the exclusion is explicit and
  // reviewable rather than silent. The XR/TUI surfaces are covered by the
  // plugin's own SmartglassesView tests.
  test.skip(
    true,
    "facewear GUI moved to Settings → Wearables; standalone view is XR/TUI-only (see plugins/plugin-facewear/src/index.ts).",
  );
  await openAppPath(page, "/apps/facewear");
});
