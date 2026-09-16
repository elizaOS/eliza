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
import { seedStewardSession } from "./helpers/test-auth";

/**
 * Full cloud-agent provisioning lifecycle through the REAL Settings UI:
 * provision (seeded + create) → list in Settings → delete agents → reprovision
 * another → delete the original. Exercises the `CloudAgentsSection` CRUD path
 * (`getCloudCompatAgents` / `deleteCloudCompatAgent` / `selectOrProvisionCloudAgent`)
 * end to end through canonical direct Cloud transport, with the cloud API faked
 * by a single stateful in-memory agent store so the renderer drives every
 * transition.
 *
 * Onboarding-time provisioning is covered by cloud-provisioning-startup.spec.ts;
 * this spec owns the post-provision management lifecycle the dashboard exposes.
 */

const AGENT_AUTH_TOKEN = "ui-smoke-cloud-lifecycle-agent-token";
const STEWARD_AUTH_TOKEN = "ui-smoke-cloud-lifecycle-steward-token";
const HANDOFF_AUTH_TOKEN = "ui-smoke-cloud-handoff-token";
const CLOUD_API_BASE = "https://api.eliza.app";
const KEEP_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DROP_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const NEW_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const VOICE_PREFIX_DONE_STORAGE_KEY = "eliza:voice:prefix-done";

type StoreAgent = {
  id: string;
  agentName: string;
  status: string;
};

type CreateAgentRequest = {
  agentName?: string;
  alwaysOn?: boolean;
  forceCreate?: boolean;
};

type CloudSessionTokens = {
  agentAccessToken: string;
  stewardToken: string;
};

type AgentStore = {
  agents: StoreAgent[];
  createdAgentId: string;
  createRequests: CreateAgentRequest[];
};

function dedicatedAgentApiBase(agentId: string): string {
  return `https://${agentId}.cloud.eliza.app`;
}

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

function expectStewardAuthorization(route: Route): void {
  const authorization = route.request().headers().authorization;
  expect(authorization).toBe(`Bearer ${STEWARD_AUTH_TOKEN}`);
  expect(authorization).not.toBe(`Bearer ${AGENT_AUTH_TOKEN}`);
}

/**
 * Keep the dedicated-agent origin real enough for client classification while
 * routing its otherwise-unhandled requests into the deterministic smoke server.
 * The dedicated client also resolves control-plane requests through the
 * canonical Cloud origin, so both origins share the same local transport.
 * Register these first because Playwright evaluates later route handlers first.
 */
async function installCloudOriginFallbacks(
  page: Page,
  apiBase: string,
): Promise<void> {
  for (const origin of [
    dedicatedAgentApiBase(KEEP_AGENT_ID),
    dedicatedAgentApiBase(DROP_AGENT_ID),
    dedicatedAgentApiBase(NEW_AGENT_ID),
    CLOUD_API_BASE,
  ]) {
    await page.route(`${origin}/**`, async (route) => {
      const requestUrl = new URL(route.request().url());
      const localUrl = new URL(apiBase);
      localUrl.pathname = requestUrl.pathname;
      localUrl.search = requestUrl.search;

      const response = await route.fetch({ url: localUrl.toString() });
      await route.fulfill({ response });
    });
  }
}

/**
 * The embedded agent list only mounts after the trusted native shell verifies
 * its Steward session against the canonical Cloud account endpoints. Register
 * these after the origin adapter so the exact account contracts win.
 */
async function installConnectedCloudAccount(page: Page): Promise<void> {
  await page.route(`${CLOUD_API_BASE}/api/v1/user`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    expectStewardAuthorization(route);
    await fulfillJson(route, 200, {
      id: "ui-smoke-lifecycle-user",
      organization_id: "ui-smoke-lifecycle-org",
    });
  });
  await page.route(
    `${CLOUD_API_BASE}/api/v1/credits/balance`,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      expectStewardAuthorization(route);
      await fulfillJson(route, 200, { balance: 100 });
    },
  );
}

/** Serialize one agent into the cloud's REST shape (snake_case + aliases). */
function serializeAgent(agent: StoreAgent): Record<string, unknown> {
  return {
    id: agent.id,
    agent_id: agent.id,
    agentName: agent.agentName,
    agent_name: agent.agentName,
    status: agent.status,
    // A dedicated agent is reachable at its own base; point it at the live stack
    // so a re-bind after create resolves to a server the smoke stack serves.
    bridge_url: dedicatedAgentApiBase(agent.id),
    bridgeUrl: dedicatedAgentApiBase(agent.id),
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
 * Register a stateful fake for the canonical direct Cloud agent collection and
 * item endpoints. One mutable store keeps list/create/delete consistent across
 * the whole flow.
 */
async function installAgentStoreRoutes(
  page: Page,
  store: AgentStore,
): Promise<void> {
  // Collection: GET = list, POST = create. Match the exact collection paths
  // (no trailing segment) so the per-agent routes below own `/<id>`.
  await page.route(`${CLOUD_API_BASE}/api/v1/eliza/agents`, async (route) => {
    expectStewardAuthorization(route);
    const method = route.request().method();
    if (method === "GET") {
      await fulfillJson(route, 200, {
        success: true,
        data: store.agents.map(serializeAgent),
      });
      return;
    }
    if (method === "POST") {
      const body =
        (route.request().postDataJSON() as CreateAgentRequest | null) ?? {};
      store.createRequests.push(body);
      const id = store.createdAgentId;
      const agent: StoreAgent = {
        id,
        agentName: body.agentName || id,
        status: "running",
      };
      store.agents.push(agent);
      await fulfillJson(route, 200, {
        success: true,
        // The UI's forced-create path requires the server's explicit
        // fresh-creation confirmation (client-cloud.ts
        // requireConfirmedFreshCloudAgentCreate rejects
        // `forceCreate && created !== true`); omit it and createAgent
        // treats the response as idempotent reuse and never binds.
        created: true,
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

  // Per-agent: GET = detail, DELETE = remove, POST(.../provision) = ack.
  await page.route(`${CLOUD_API_BASE}/api/v1/eliza/agents/*`, async (route) => {
    expectStewardAuthorization(route);
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
        data: serializeAgent(agent),
      });
      return;
    }
    if (method === "DELETE") {
      store.agents = store.agents.filter((a) => a.id !== id);
      // An empty jobId makes this direct CRUD response synchronous, so no
      // separate job transport can conceal whether the row was removed.
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

async function seedCloudActiveAgent(
  page: Page,
  agentId: string,
  apiBase: string,
  tokens: CloudSessionTokens,
): Promise<void> {
  await seedAppStorage(page, {
    "elizaos:active-server": JSON.stringify({
      id: `cloud:${agentId}`,
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase,
      accessToken: tokens.agentAccessToken,
    }),
    // Loopback shells quarantine Steward credentials by Cloud deployment.
    // This lifecycle fixture targets production Cloud, so seed the matching
    // scope alongside the protected token just as a completed login does.
    steward_session_token_scope: "eliza-cloud:production",
    steward_session_active_scope: "eliza-cloud:production",
    "eliza:mobile-runtime-mode": "cloud",
  });
  await page.addInitScript(
    ({ voiceKey }) => {
      localStorage.setItem(voiceKey, "1");
    },
    { voiceKey: VOICE_PREFIX_DONE_STORAGE_KEY },
  );
  await seedStewardSession(page, { token: tokens.stewardToken });
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

  const forbiddenCloudProxyRequests: Array<{ method: string; url: string }> =
    [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/cloud/compat/") || url.includes("/api/cloud/v1/")) {
      forbiddenCloudProxyRequests.push({ method: request.method(), url });
    }
  });

  await page.addInitScript(({ stewardToken }) => {
    const protectedKey = (key: string) => `ui-smoke:secure-store:${key}`;
    // Seed the native source of truth directly. Init-script ordering is not
    // guaranteed, so relying on plaintext migration can race bridge hydration
    // and strand the post-create reload in Cloud reauthentication.
    localStorage.setItem(
      protectedKey("session.steward_token"),
      stewardToken,
    );
    const win = window as Window & {
      Capacitor?: {
        PluginHeaders?: Array<{
          name: string;
          methods: Array<{
            name: string;
            rtype: "promise" | "callback";
          }>;
        }>;
        nativePromise?: (
          pluginName: string,
          methodName: string,
          options?: unknown,
        ) => Promise<unknown>;
        nativeCallback?: (
          pluginName: string,
          methodName: string,
          options?: unknown,
          callback?: (...args: unknown[]) => void,
        ) => string;
      };
      CapacitorCustomPlatform?: {
        name: string;
        plugins: Record<string, unknown>;
      };
    };
    win.CapacitorCustomPlatform = { name: "android", plugins: {} };
    win.Capacitor = {
      ...(win.Capacitor ?? {}),
      PluginHeaders: [
        {
          name: "StatusBar",
          methods: [
            { name: "setStyle", rtype: "promise" },
            { name: "setOverlaysWebView", rtype: "promise" },
            { name: "setBackgroundColor", rtype: "promise" },
          ],
        },
        {
          name: "Keyboard",
          methods: [
            { name: "addListener", rtype: "callback" },
            { name: "removeListener", rtype: "promise" },
          ],
        },
        {
          name: "DeepLinkBuffer",
          methods: [
            { name: "peekPendingUrl", rtype: "promise" },
            { name: "acknowledgePendingUrl", rtype: "promise" },
          ],
        },
        {
          name: "CapacitorBackgroundRunner",
          methods: [{ name: "dispatchEvent", rtype: "promise" }],
        },
        {
          name: "ElizaSecureStore",
          methods: ["get", "set", "remove", "status"].map((name) => ({
            name,
            rtype: "promise" as const,
          })),
        },
      ],
      nativePromise: async (pluginName, methodName, options) => {
        const call = `${pluginName}.${methodName}`;
        if (call === "DeepLinkBuffer.peekPendingUrl") return { url: null };
        if (call === "DeepLinkBuffer.acknowledgePendingUrl") {
          return { cleared: true };
        }
        if (
          call === "StatusBar.setStyle" ||
          call === "StatusBar.setOverlaysWebView" ||
          call === "StatusBar.setBackgroundColor" ||
          call === "Keyboard.removeListener" ||
          call === "CapacitorBackgroundRunner.dispatchEvent"
        ) {
          return {};
        }
        if (pluginName === "ElizaSecureStore") {
          const record = (options ?? {}) as Record<string, unknown>;
          const key = String(record.key ?? "");
          if (methodName === "get") {
            const value = localStorage.getItem(protectedKey(key));
            return value === null
              ? { ok: false, error: "not_found" }
              : { ok: true, value };
          }
          if (methodName === "set") {
            localStorage.setItem(
              protectedKey(key),
              String(record.value ?? ""),
            );
            return { ok: true };
          }
          if (methodName === "remove") {
            localStorage.removeItem(protectedKey(key));
            return { ok: true };
          }
          if (methodName === "status") {
            return {
              available: true,
              hardwareBacked: false,
              authenticationRequired: false,
            };
          }
        }
        throw new Error(`Unexpected native promise call: ${call}`);
      },
      nativeCallback: (pluginName, methodName, options) => {
        const call = `${pluginName}.${methodName}`;
        if (call !== "Keyboard.addListener") {
          throw new Error(`Unexpected native callback call: ${call}`);
        }
        return `keyboard-listener:${String(options)}`;
      },
    };
  }, { stewardToken: STEWARD_AUTH_TOKEN });

  // Two provisioned agents; the seeded active one is KEEP_AGENT_ID.
  const store: AgentStore = {
    agents: [
      { id: KEEP_AGENT_ID, agentName: "Keeper", status: "running" },
      { id: DROP_AGENT_ID, agentName: "Disposable", status: "running" },
    ],
    createdAgentId: NEW_AGENT_ID,
    createRequests: [],
  };

  await seedCloudActiveAgent(
    page,
    KEEP_AGENT_ID,
    dedicatedAgentApiBase(KEEP_AGENT_ID),
    {
      agentAccessToken: AGENT_AUTH_TOKEN,
      stewardToken: STEWARD_AUTH_TOKEN,
    },
  );
  await installCloudOriginFallbacks(page, apiBase);
  await installDefaultAppRoutes(page);
  await installConnectedCloudAccount(page);
  await installAgentStoreRoutes(page, store);

  // Cloud agents are embedded in the Cloud Overview settings section.
  await openAppPath(page, "/settings");
  await openSettingsSection(page, "Overview");

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
  expect(store.agents.map((a) => a.id)).toEqual([KEEP_AGENT_ID]);

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
          if (!raw) return null;
          const active = JSON.parse(raw) as {
            id?: string;
            apiBase?: string;
          };
          return { id: active.id, apiBase: active.apiBase };
        }),
      { timeout: 30_000 },
    )
    .toEqual({
      id: `cloud:${NEW_AGENT_ID}`,
      apiBase: dedicatedAgentApiBase(NEW_AGENT_ID),
    });
  expect(store.createRequests).toEqual([
    { agentName: "Fresh Agent", alwaysOn: true, forceCreate: true },
  ]);
  expect(store.agents.map((a) => a.agentName).sort()).toEqual([
    "Fresh Agent",
    "Keeper",
  ]);

  // --- After the reload the new agent is active; the original is now deletable.
  await openAppPath(page, "/settings");
  await openSettingsSection(page, "Overview");
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
  expect(store.agents.map((a) => a.id)).toEqual([NEW_AGENT_ID]);
  expect(forbiddenCloudProxyRequests).toEqual([]);
});

/**
 * The shared→dedicated handoff surfaces. There is no floating banner: while a
 * dedicated container boots, the home-grid agent-provisioning tile shows the
 * background work (and self-hides on the switch), and a failed/timed-out
 * handoff speaks IN THE CHAT via the boot-recovery conductor — an assistant
 * turn whose "Retry setup" control dispatches `eliza:cloud-handoff-retry`,
 * which the handoff runner consumes to re-invoke the (idempotent) supervisor.
 * Here we drive the same `eliza:cloud-handoff-phase` event the first-run
 * controller emits and assert those user-visible surfaces in the live shell.
 */
test("cloud handoff: home tile tracks migrating→switched, failures speak in chat with Retry setup", async ({
  page,
  baseURL,
}) => {
  const apiBase = (baseURL ?? "").replace(/\/$/, "");
  expect(apiBase, "Playwright baseURL must be configured").toBeTruthy();

  await seedCloudActiveAgent(page, "agent-keep", apiBase, {
    agentAccessToken: HANDOFF_AUTH_TOKEN,
    stewardToken: HANDOFF_AUTH_TOKEN,
  });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/");

  // Capture every retry event the in-chat control dispatches so we can assert
  // the failure path re-invokes the handoff for the right agent.
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

  // migrating: a background process with NO floating surface — the old toast
  // ("you can keep chatting") must never appear; the home-grid provisioning
  // tile is the durable surface (covered by its own widget rendering, which
  // this fixture's bare view catalog does not mount).
  await emitPhase({ agentId: "agent-keep", phase: "migrating" });
  await expect(page.getByText(/keep chatting/i)).toHaveCount(0);

  // failed: a recoverable failure speaks in the transcript via the
  // boot-recovery conductor with a specific remedy (instead of a silent
  // permanent fallback to the shared adapter). The shell (which attaches the
  // window listener) renders after the boot sequence; a CustomEvent fired
  // before the listener is attached is simply dropped (not buffered) — re-emit
  // until the in-chat card lands so the test isn't racing the shell mount.
  const retrySetup = page.getByTestId("choice-__boot_recovery__:retry-handoff");
  await expect(async () => {
    await emitPhase({
      agentId: "agent-keep",
      phase: "failed",
      error: "boot timeout",
    });
    await expect(retrySetup).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText(/dedicated agent/i).first()).toBeVisible();
  await retrySetup.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as { __handoffRetries?: string[] }).__handoffRetries ??
          [],
      ),
    )
    .toContain("agent-keep");

  // switched: the dedicated agent attached — the recovery card clears; the
  // transcript goes quiet instead of celebrating with a floating toast.
  await emitPhase({ agentId: "agent-keep", phase: "switched", imported: 3 });
  await expect(retrySetup).toHaveCount(0);
  await expect(page.getByText(/now on your dedicated agent/i)).toHaveCount(0);
});
