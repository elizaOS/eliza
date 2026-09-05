/**
 * Runtime bridge inventory for plugin views that mount in the browser shell.
 *
 * Each target opens its real rendered route and proves that chat and voice can
 * enumerate every interactive control through `viewInteract`. Native-OS Phone,
 * Contacts, and Messages are exercised on device rather than through the web
 * shell; Shopify has no shipped view declaration. The sibling inventory covers
 * wallet inventory, orchestrator, and feed.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  hideChatOverlay,
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
    __ELIZA_BRIDGE__?: {
      readonly viewInteract?: (
        viewId: string,
        viewType: string,
        capability: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
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

// Ordered by surface family so a failure localizes to a cohesive group.
const PLUGIN_VIEW_TARGETS: readonly PluginViewTarget[] = [
  // --- LifeOps decomposed views (spatial `Button agent=…` + DomSection ids) ---
  {
    label: "Calendar",
    path: "/calendar",
    viewId: "calendar",
    // The canonical calendar exposes range navigation, view selection, and
    // event creation through stable agent bridge controls.
    ready: { testId: "lifeops-calendar-section" },
    requiredIds: [
      "calendar-prev",
      "calendar-today",
      "calendar-next",
      "calendar-view-mode",
      "calendar-new-event",
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
          () => typeof window.__ELIZA_BRIDGE__?.viewInteract === "function",
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
      const bridge = window.__ELIZA_BRIDGE__?.viewInteract;
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
 * gap. DynamicViewLoader gives each plugin one `data-spatial-surface`; choosing
 * the surface with the most registered nodes keeps wallet/header and hidden
 * chat controls out while still catching controls beside the view's wired
 * controls.
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

    const surfaceCounts = new Map<HTMLElement, number>();
    for (const node of agentNodes) {
      const surface = node.closest<HTMLElement>("[data-spatial-surface]");
      if (surface) {
        surfaceCounts.set(surface, (surfaceCounts.get(surface) ?? 0) + 1);
      }
    }
    const root =
      [...surfaceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      document.getElementById("root") ??
      document.body;

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
        const text = el.textContent?.trim().replace(/\s+/g, " ").slice(0, 60);
        const testId = el.getAttribute("data-testid");
        gaps.push(
          `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${
            aria ? `(${aria})` : text ? `(${text})` : ""
          }${testId ? `[data-testid=${testId}]` : ""}`,
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
  await hideChatOverlay(page);
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
