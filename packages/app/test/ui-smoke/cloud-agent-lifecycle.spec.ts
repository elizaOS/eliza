/**
 * Playwright UI-smoke spec for the Cloud Agent Lifecycle app flow using the
 * real renderer fixture.
 */
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

/**
 * Full cloud-agent provisioning lifecycle through the REAL Settings UI:
 * provision (seeded + create) → list in Settings → delete agents → reprovision
 * another → delete the original. Exercises the `CloudAgentsSection` CRUD path
 * (`getCloudCompatAgents` / `deleteCloudCompatAgent` / `selectOrProvisionCloudAgent`)
 * end to end against the live ui-smoke stack, with the cloud API faked by a
 * single stateful in-memory agent store so the renderer drives every transition.
 *
 * Onboarding-time provisioning is covered by cloud-provisioning-startup.spec.ts;
 * this spec owns the post-provision management lifecycle the dashboard exposes.
 */

const CLOUD_AUTH_TOKEN = "ui-smoke-cloud-lifecycle-token";
const VOICE_PREFIX_DONE_STORAGE_KEY = "eliza:voice:prefix-done";

type StoreAgent = {
  id: string;
  agentName: string;
  status: string;
};

type AgentStore = {
  agents: StoreAgent[];
  nextId: number;
};

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** Serialize one agent into the cloud's REST shape (snake_case + aliases). */
function serializeAgent(
  agent: StoreAgent,
  apiBase: string,
): Record<string, unknown> {
  return {
    id: agent.id,
    agent_id: agent.id,
    agentName: agent.agentName,
    agent_name: agent.agentName,
    status: agent.status,
    // A dedicated agent is reachable at its own base; point it at the live stack
    // so a re-bind after create resolves to a server the smoke stack serves.
    bridge_url: apiBase,
    bridgeUrl: apiBase,
    web_ui_url: null,
    webUiUrl: null,
    containerUrl: "",
    database_status: "ready",
    error_message: null,
    agent_config: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:02.000Z",
    last_heartbeat_at: "2026-01-01T00:00:02.000Z",
  };
}

function lastPathSegment(url: string): string {
  const path = new URL(url).pathname.replace(/\/$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Register a stateful fake for every cloud agent endpoint the dashboard can
 * reach — direct (`api.elizacloud.ai/api/v1/eliza/agents`) and local-proxy
 * (`/api/cloud/compat/agents`, `/api/cloud/v1/...`) — backed by one mutable
 * store so list/create/delete stay consistent across the whole flow.
 */
async function installAgentStoreRoutes(
  page: Page,
  store: AgentStore,
  apiBase: string,
): Promise<void> {
  // Collection: GET = list, POST = create. Match the exact collection paths
  // (no trailing segment) so the per-agent routes below own `/<id>`.
  const collectionPatterns = [
    "https://api.elizacloud.ai/api/v1/eliza/agents",
    "**/api/cloud/compat/agents",
    "**/api/cloud/v1/eliza/agents",
  ];
  for (const pattern of collectionPatterns) {
    await page.route(pattern, async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await fulfillJson(route, 200, {
          success: true,
          data: store.agents.map((a) => serializeAgent(a, apiBase)),
        });
        return;
      }
      if (method === "POST") {
        const body =
          (route.request().postDataJSON() as { agentName?: string } | null) ??
          {};
        const id = `agent-${(store.nextId += 1)}`;
        const agent: StoreAgent = {
          id,
          agentName: body.agentName || id,
          status: "running",
        };
        store.agents.push(agent);
        await fulfillJson(route, 200, {
          success: true,
          data: {
            id,
            agentId: id,
            agentName: agent.agentName,
            jobId: "",
            status: "running",
            nodeId: null,
            message: "Agent created",
          },
        });
        return;
      }
      await route.fallback();
    });
  }

  // Per-agent: GET = detail, DELETE = remove, POST(.../provision) = ack.
  const itemPatterns = [
    "https://api.elizacloud.ai/api/v1/eliza/agents/*",
    "**/api/cloud/compat/agents/*",
    "**/api/cloud/v1/eliza/agents/*",
  ];
  for (const pattern of itemPatterns) {
    await page.route(pattern, async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      // Sub-resources (…/provision, …/launch, …/pairing-token) just ack.
      if (!/\/agents\/[^/]+$/.test(new URL(url).pathname)) {
        await fulfillJson(route, 200, {
          success: true,
          data: { jobId: "job-x", status: "completed" },
        });
        return;
      }
      const id = lastPathSegment(url);
      const agent = store.agents.find((a) => a.id === id);
      if (method === "GET") {
        if (!agent) {
          await fulfillJson(route, 404, { success: false, error: "Not found" });
          return;
        }
        await fulfillJson(route, 200, {
          success: true,
          data: serializeAgent(agent, apiBase),
        });
        return;
      }
      if (method === "DELETE") {
        store.agents = store.agents.filter((a) => a.id !== id);
        // jobId:"" → the UI treats the delete as synchronous and drops the row
        // immediately; the job route below still answers if a jobId is polled.
        await fulfillJson(route, 200, {
          success: true,
          data: { jobId: "", status: "deleted", message: "Agent deleted" },
        });
        return;
      }
      if (method === "POST") {
        await fulfillJson(route, 200, {
          success: true,
          data: { jobId: "job-x", status: "completed", agentId: id },
        });
        return;
      }
      await route.fallback();
    });
  }

  // Any delete/provision job poll → completed (covers a synthesized job-delete).
  const jobPatterns = [
    "https://api.elizacloud.ai/api/v1/jobs/*",
    "**/api/cloud/compat/jobs/*",
    "**/api/cloud/v1/jobs/*",
  ];
  for (const pattern of jobPatterns) {
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      const jobId = lastPathSegment(route.request().url());
      await fulfillJson(route, 200, {
        success: true,
        data: {
          id: jobId,
          jobId,
          type: "agent_delete",
          status: "completed",
          state: "completed",
          data: {},
          result: {},
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          retryCount: 0,
        },
      });
    });
  }
}

async function seedCloudActiveAgent(
  page: Page,
  agentId: string,
  apiBase: string,
): Promise<void> {
  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: `cloud:${agentId}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: CLOUD_AUTH_TOKEN,
    }),
    "eliza:mobile-runtime-mode": "cloud",
  });
  await page.addInitScript(
    ({ token, voiceKey }) => {
      localStorage.setItem(voiceKey, "1");
      localStorage.setItem("steward_session_token", token);
    },
    { token: CLOUD_AUTH_TOKEN, voiceKey: VOICE_PREFIX_DONE_STORAGE_KEY },
  );
}

function agentRow(page: Page, name: string) {
  return page.getByText(name, { exact: true });
}

test("cloud agents: list, delete, then reprovision another from Settings", async ({
  page,
  baseURL,
}) => {
  const apiBase = (baseURL ?? "").replace(/\/$/, "");
  expect(apiBase, "Playwright baseURL must be configured").toBeTruthy();

  // Two provisioned agents; the seeded active one is "agent-keep".
  const store: AgentStore = {
    agents: [
      { id: "agent-keep", agentName: "Keeper", status: "running" },
      { id: "agent-drop", agentName: "Disposable", status: "running" },
    ],
    nextId: 100,
  };

  await seedCloudActiveAgent(page, "agent-keep", apiBase);
  await installDefaultAppRoutes(page);
  await installAgentStoreRoutes(page, store, apiBase);

  // --- Open Settings → Agents and confirm both provisioned agents are listed.
  await openAppPath(page, "/settings");
  await openSettingsSection(page, "Agents");

  await expect(agentRow(page, "Keeper")).toBeVisible({ timeout: 30_000 });
  await expect(agentRow(page, "Disposable")).toBeVisible();
  await expect(page.getByTestId("cloud-agents-empty")).toHaveCount(0);

  // The active agent's delete is intentionally disabled; the other is deletable.
  await expect(
    page.getByRole("button", { name: "Delete Disposable" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Delete Keeper" }),
  ).toBeDisabled();

  // --- Delete the non-active agent; the row disappears, the keeper remains.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete Disposable" }).click();
  await expect(agentRow(page, "Disposable")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(agentRow(page, "Keeper")).toBeVisible();
  expect(store.agents.map((a) => a.id)).toEqual(["agent-keep"]);

  // --- Reprovision: create a brand-new agent; the section binds it active and
  // reloads the app (the same path a returning user takes on switch).
  await page.getByPlaceholder(/Agent name/i).fill("Fresh Agent");
  await page.getByRole("button", { name: /^Create$/ }).click();

  // bindAndReload persists the new agent as the active cloud server and reloads.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const raw = localStorage.getItem("elizaos:active-server");
          return raw ? (JSON.parse(raw) as { id?: string }).id : null;
        }),
      { timeout: 30_000 },
    )
    .toBe("cloud:agent-101");
  expect(store.agents.map((a) => a.agentName).sort()).toEqual([
    "Fresh Agent",
    "Keeper",
  ]);

  // --- After the reload the new agent is active; the original is now deletable.
  await openAppPath(page, "/settings");
  await openSettingsSection(page, "Agents");
  await expect(agentRow(page, "Fresh Agent")).toBeVisible({ timeout: 30_000 });
  await expect(agentRow(page, "Keeper")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete Fresh Agent" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete Keeper" }),
  ).toBeEnabled();

  // --- Delete the original; only the freshly provisioned agent survives.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete Keeper" }).click();
  await expect(agentRow(page, "Keeper")).toHaveCount(0, { timeout: 30_000 });
  await expect(agentRow(page, "Fresh Agent")).toBeVisible();
  expect(store.agents.map((a) => a.id)).toEqual(["agent-101"]);
});

/**
 * The shared→dedicated handoff progress pill ({@link CloudHandoffBanner},
 * mounted globally in `App.tsx`). The first-run controller drives this banner
 * off the `ConversationHandoffResult` via the `eliza:cloud-handoff-phase` event;
 * here we drive that same event directly to assert the user-visible
 * `migrating → switched` transition (and the retry path) render in the live app
 * shell — the on-device-legible pill, not a silent swap. The Retry button
 * dispatches `eliza:cloud-handoff-retry` for the agent, which the handoff runner
 * consumes to re-invoke the (idempotent) supervisor.
 */
test("cloud handoff: the migrating→switched pill is visible, and failures offer Retry", async ({
  page,
  baseURL,
}) => {
  const apiBase = (baseURL ?? "").replace(/\/$/, "");
  expect(apiBase, "Playwright baseURL must be configured").toBeTruthy();

  await seedCloudActiveAgent(page, "agent-keep", apiBase);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/");

  // Capture every retry event the banner dispatches so we can assert the
  // failure path re-invokes the handoff for the right agent.
  await page.evaluate(() => {
    const w = globalThis as Record<string, unknown>;
    w.__handoffRetries = [];
    window.addEventListener("eliza:cloud-handoff-retry", (e) => {
      (w.__handoffRetries as string[]).push(
        (e as CustomEvent<{ agentId: string }>).detail.agentId,
      );
    });
  });

  const emitPhase = (detail: Record<string, unknown>) =>
    page.evaluate((detail) => {
      window.dispatchEvent(
        new CustomEvent("eliza:cloud-handoff-phase", { detail }),
      );
    }, detail);

  // migrating: the dedicated container is booting; the user keeps chatting.
  // The app shell (which mounts CloudHandoffBanner + attaches the window
  // listener) renders after the boot/first-run sequence; a CustomEvent fired
  // before the listener is attached is simply dropped (not buffered). Re-emit
  // until the pill lands so the test isn't racing the shell mount.
  await expect(async () => {
    await emitPhase({ agentId: "agent-keep", phase: "migrating" });
    await expect(page.getByText(/keep chatting/i)).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 45_000 });

  // switched: the live client has swapped to the dedicated container.
  await emitPhase({ agentId: "agent-keep", phase: "switched", imported: 3 });
  await expect(page.getByText(/now on your dedicated agent/i)).toBeVisible();

  // failed: a recoverable failure surfaces a Retry that re-invokes the handoff
  // (instead of a silent permanent fallback to the shared adapter).
  await emitPhase({
    agentId: "agent-keep",
    phase: "failed",
    error: "boot timeout",
  });
  await expect(page.getByText(/still on the shared one/i)).toBeVisible();
  await page.getByTestId("cloud-handoff-retry").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as { __handoffRetries?: string[] }).__handoffRetries ??
          [],
      ),
    )
    .toContain("agent-keep");
});
