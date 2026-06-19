import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { expect, test } from "@playwright/test";
import { getFreePort } from "../utils/get-free-port.mjs";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

type RemoteServerState = {
  bundleRequests: number;
  manifestRequests: number;
};

type RemoteCapabilityServer = {
  baseUrl: string;
  state: RemoteServerState;
  close: () => Promise<void>;
};

test("app shell loads a remote capability view bundle from a running endpoint", async ({
  page,
}) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  const remote = await startRemoteCapabilityServer();
  try {
    await page.route("**/api/views**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname !== "/api/views") {
        await route.fallback();
        return;
      }
      const views = await remoteViewsFromManifest(remote.baseUrl);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ views }),
      });
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        pageErrors.push(message.text());
      }
    });

    await openAppPath(page, "/apps/remote-capability-live");

    await assertReadyChecks(
      page,
      "remote capability live view",
      [{ selector: '[data-testid="remote-capability-live-view"]' }],
      "all",
    );
    await expect(page.getByText("Remote capability live view")).toBeVisible();
    await expect(page.getByText("Exit label: Leave remote view")).toBeVisible();
    await expect.poll(() => remote.state.manifestRequests).toBeGreaterThan(0);
    await expect.poll(() => remote.state.bundleRequests).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await remote.close();
  }
});

test("settings connects a remote capability endpoint and opens its view", async ({
  page,
}) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  const remote = await startRemoteCapabilityServer();
  let connected = false;
  let connectPayload: unknown = null;

  try {
    await page.route("**/api/capability-router/connect", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      connectPayload = route.request().postDataJSON();
      const manifestResponse = await fetch(
        `${remote.baseUrl}/v1/capabilities/invoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method: "plugin.modules.list",
            params: {},
          }),
        },
      );
      const manifest = (await manifestResponse.json()) as {
        result?: {
          modules?: Array<{ name: string }>;
        };
      };
      connected = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          mode: "endpoint",
          endpoint: {
            id: "live-product",
            baseUrl: remote.baseUrl,
            hasToken: true,
          },
          persisted: true,
          sync: {
            registered:
              manifest.result?.modules?.map((module) => module.name) ?? [],
            unloaded: [],
            skipped: [],
          },
        }),
      });
    });

    await page.route("**/api/views**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname !== "/api/views") {
        await route.fallback();
        return;
      }
      const views = connected
        ? await remoteViewsFromManifest(remote.baseUrl)
        : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ views }),
      });
    });

    await openAppPath(page, "/settings");
    await openSettingsSection(page, /^Capabilities\b/);

    await page
      .getByLabel("Capability endpoint provider")
      .selectOption("home-machine");
    await page
      .getByLabel("Capability router endpoint URL")
      .fill(remote.baseUrl);
    await page.getByLabel("Capability router endpoint ID").fill("live-product");
    await page
      .getByLabel("Capability router endpoint token")
      .fill("product-token");
    await page
      .getByLabel("Allowed remote module IDs")
      .fill("remote-capability-live, remote-capability-live");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(
      page.getByText("Connected remote capability endpoint."),
    ).toBeVisible();
    await expect(page.getByText("@remote/capability-live")).toBeVisible();
    expect(connectPayload).toMatchObject({
      provider: "home-machine",
      endpoint: {
        id: "live-product",
        baseUrl: remote.baseUrl,
        token: "product-token",
      },
      persist: true,
      unloadMissing: false,
      allowedModuleIds: ["remote-capability-live"],
    });

    await openAppPath(page, "/apps/remote-capability-live");
    await assertReadyChecks(
      page,
      "remote capability live view after connect",
      [{ selector: '[data-testid="remote-capability-live-view"]' }],
      "all",
    );
    await expect.poll(() => remote.state.manifestRequests).toBeGreaterThan(0);
    await expect.poll(() => remote.state.bundleRequests).toBeGreaterThan(0);
  } finally {
    await remote.close();
  }
});

test("settings provisions a cloud capability sandbox", async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  let connectPayload: unknown = null;
  await page.route("**/api/capability-router/connect", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    connectPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        mode: "cloud",
        agentId: "agent-cloud-smoke",
        endpoint: {
          id: "cloud-product",
          baseUrl: "https://cloud-capability.example.test",
          hasToken: true,
        },
        persisted: true,
        sync: {
          registered: ["@remote/cloud-capability"],
          unloaded: [],
          skipped: [],
          trustDecisions: [
            {
              moduleId: "cloud-capability",
              pluginName: "@remote/cloud-capability",
              endpointId: "cloud-product",
              trusted: true,
              reason: "allowed",
            },
          ],
        },
      }),
    });
  });

  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Capabilities\b/);

  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await page
    .getByLabel("Capability cloud API base URL")
    .fill("https://api.elizacloud.ai");
  await page.getByLabel("Capability cloud auth token").fill("cloud-auth");
  await page
    .getByLabel("Capability cloud sandbox name")
    .fill("Cloud Remote Tools");
  await page
    .getByLabel("Capability cloud sandbox bio")
    .fill("Builds remote plugins");
  await page.getByLabel("Capability router endpoint ID").fill("cloud-product");
  await page
    .getByLabel("Capability router endpoint token")
    .fill("endpoint-token");
  await page
    .getByLabel("Allowed remote module IDs")
    .fill("cloud-capability, cloud-capability");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(
    page.getByText("Connected remote capability endpoint."),
  ).toBeVisible();
  await expect(page.getByText("@remote/cloud-capability")).toBeVisible();
  expect(connectPayload).toMatchObject({
    cloud: {
      cloudApiBase: "https://api.elizacloud.ai",
      authToken: "cloud-auth",
      name: "Cloud Remote Tools",
      bio: ["Builds remote plugins"],
      endpointId: "cloud-product",
      token: "endpoint-token",
      allowedModuleIds: ["cloud-capability"],
    },
    persist: true,
    unloadMissing: false,
  });
});

async function startRemoteCapabilityServer(): Promise<RemoteCapabilityServer> {
  const port = await getFreePort();
  const state: RemoteServerState = {
    bundleRequests: 0,
    manifestRequests: 0,
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createServer((req, res) => {
    void handleRemoteRequest(req, res, baseUrl, state);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    baseUrl,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRemoteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  state: RemoteServerState,
): Promise<void> {
  const url = new URL(req.url ?? "/", baseUrl);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/capabilities") {
    sendJson(res, 200, {
      environment: "server",
      available: true,
      capabilities: { plugin: true },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/capabilities/invoke") {
    state.manifestRequests += 1;
    sendJson(res, 200, {
      ok: true,
      result: {
        modules: [
          {
            id: "remote-capability-live",
            name: "@remote/capability-live",
            views: [
              {
                id: "remote-capability-live.view",
                label: "Remote Capability Live",
                viewType: "gui",
                bundleUrl: `${baseUrl}/assets/remote-capability-live.js`,
              },
            ],
          },
        ],
      },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/assets/remote-capability-live.js"
  ) {
    state.bundleRequests += 1;
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(`
const React = await window.__ELIZA_DYNAMIC_VIEW_IMPORT__("react");

export default function RemoteCapabilityLiveView(props) {
  return React.createElement(
    "section",
    { "data-testid": "remote-capability-live-view" },
    React.createElement("h1", null, "Remote capability live view"),
    React.createElement(
      "p",
      null,
      "Exit label: " + props.t("remote.exit", { defaultValue: "Leave remote view" })
    )
  );
}
`);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function remoteViewsFromManifest(baseUrl: string): Promise<
  Array<{
    id: string;
    label: string;
    viewType: "gui" | "tui";
    pluginName: string;
    path: string;
    bundleUrl?: string;
    available: boolean;
    visibleInManager: boolean;
  }>
> {
  const manifestResponse = await fetch(`${baseUrl}/v1/capabilities/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "plugin.modules.list",
      params: {},
    }),
  });
  const manifest = (await manifestResponse.json()) as {
    result?: {
      modules?: Array<{
        id: string;
        name: string;
        views?: Array<{
          id: string;
          label: string;
          viewType?: "gui" | "tui";
          bundleUrl?: string;
        }>;
      }>;
    };
  };
  return (
    manifest.result?.modules?.flatMap((module) =>
      (module.views ?? []).map((view) => ({
        id: view.id,
        label: view.label,
        viewType: view.viewType ?? "gui",
        pluginName: module.name,
        path: "/apps/remote-capability-live",
        bundleUrl: view.bundleUrl,
        available: true,
        visibleInManager: true,
      })),
    ) ?? []
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
