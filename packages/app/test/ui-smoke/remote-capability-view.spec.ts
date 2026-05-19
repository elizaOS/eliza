import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { expect, test } from "@playwright/test";
import { getFreePort } from "../utils/get-free-port.mjs";
import {
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

const remoteServers: RemoteCapabilityServer[] = [];

test.afterEach(async () => {
  await Promise.all(remoteServers.splice(0).map((server) => server.close()));
});

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("app shell loads a remote capability view bundle from a running endpoint", async ({
  page,
}) => {
  const remote = await startRemoteCapabilityServer();
  remoteServers.push(remote);

  await page.route("**/api/views**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname !== "/api/views") {
      await route.fallback();
      return;
    }

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
    const views =
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
      ) ?? [];

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

  await expect(page.getByTestId("remote-capability-live-view")).toBeVisible();
  await expect(page.getByText("Remote capability live view")).toBeVisible();
  await expect(page.getByText("Exit label: Leave remote view")).toBeVisible();
  await expect.poll(() => remote.state.manifestRequests).toBeGreaterThan(0);
  await expect.poll(() => remote.state.bundleRequests).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test("settings connects a remote capability endpoint and opens its view", async ({
  page,
}) => {
  const remote = await startRemoteCapabilityServer();
  remoteServers.push(remote);
  let connected = false;
  let connectPayload: unknown = null;

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

  await page.getByLabel("Capability router endpoint URL").fill(remote.baseUrl);
  await page.getByLabel("Capability router endpoint ID").fill("live-product");
  await page
    .getByLabel("Capability router endpoint token")
    .fill("product-token");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(
    page.getByText("Connected remote capability endpoint."),
  ).toBeVisible();
  await expect(page.getByText("@remote/capability-live")).toBeVisible();
  expect(connectPayload).toMatchObject({
    endpoint: {
      id: "live-product",
      baseUrl: remote.baseUrl,
      token: "product-token",
    },
    persist: true,
    unloadMissing: false,
  });

  await openAppPath(page, "/apps/remote-capability-live");
  await expect(page.getByTestId("remote-capability-live-view")).toBeVisible();
  await expect.poll(() => remote.state.manifestRequests).toBeGreaterThan(0);
  await expect.poll(() => remote.state.bundleRequests).toBeGreaterThan(0);
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
