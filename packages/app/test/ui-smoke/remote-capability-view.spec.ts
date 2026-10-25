/**
 * Playwright UI-smoke spec for the Remote Capability View app flow using the
 * real renderer fixture.
 */
import { promises as fs } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import type { Plugin } from "@elizaos/core";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  getView,
  registerPluginViews,
} from "../../../agent/src/api/views-registry.ts";
import { createViewAssetHost as fixture } from "../../../agent/test/support/view-assets-host.ts";
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

const ADVANCED_SETTINGS_STORAGE_KEY = "eliza:settings-advanced";
// Both flags are required: developer mode exposes the section, while advanced
// settings exposes its remote-endpoint controls.
const DEVELOPER_MODE_STORAGE_KEY = "eliza:developerMode";
const REMOTE_CAPABILITY_BUNDLE_PATH =
  "/api/views/remote-capability-live/bundle.js";

// The worker owns dynamic-view caching, but Playwright cannot intercept its
// requests with page.route. Blocking it keeps this spec focused on the real
// loader against its explicitly routed remote bundle; worker caching and auth
// behavior are covered independently against public/sw.js.
test.use({ serviceWorkers: "block" });

test("app shell loads a remote capability view bundle from a running endpoint", async ({
  page,
}) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  const remote = await startRemoteCapabilityServer();
  try {
    await installRemoteCapabilityViewRoutes(page, remote);

    await page.route("**/api/views**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname === REMOTE_CAPABILITY_BUNDLE_PATH) {
        await fulfillRemoteCapabilityBundle(route, remote);
        return;
      }
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
  await seedAppStorage(page, {
    [ADVANCED_SETTINGS_STORAGE_KEY]: "1",
    [DEVELOPER_MODE_STORAGE_KEY]: "1",
  });
  await installDefaultAppRoutes(page);

  const remote = await startRemoteCapabilityServer();
  let connected = false;
  let connectPayload: unknown = null;

  try {
    await installRemoteCapabilityViewRoutes(page, remote);

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
      if (requestUrl.pathname === REMOTE_CAPABILITY_BUNDLE_PATH) {
        await fulfillRemoteCapabilityBundle(route, remote);
        return;
      }
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

    // "Capability endpoint provider" migrated from a native <select> to a Radix
    // combobox button — open it and click the option from the listbox.
    await page.getByLabel("Capability endpoint provider").click();
    await page.getByRole("option", { name: "Home machine" }).click();
    await page.getByLabel("Endpoint URL", { exact: true }).fill(remote.baseUrl);
    await page.getByLabel("Endpoint ID", { exact: true }).fill("live-product");
    await page
      .getByLabel("Bearer token", { exact: true })
      .fill("product-token");
    await page
      .getByLabel("Allowed module IDs", { exact: true })
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
  await seedAppStorage(page, {
    [ADVANCED_SETTINGS_STORAGE_KEY]: "1",
    [DEVELOPER_MODE_STORAGE_KEY]: "1",
  });
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

  // Select through the control's public accessibility contract so the test
  // follows the same radiogroup semantics as keyboard and assistive-tech users.
  await page
    .getByRole("radiogroup", { name: "Capability router connection mode" })
    .getByRole("button", { name: "cloud", exact: true })
    .click();
  await page
    .getByLabel("Cloud API base URL", { exact: true })
    .fill("https://api.elizacloud.ai");
  await page.getByLabel("Cloud auth token", { exact: true }).fill("cloud-auth");
  await page
    .getByLabel("Sandbox name", { exact: true })
    .fill("Cloud Remote Tools");
  await page
    .getByLabel("Sandbox bio", { exact: true })
    .fill("Builds remote plugins");
  await page.getByLabel("Endpoint ID", { exact: true }).fill("cloud-product");
  await page.getByLabel("Bearer token", { exact: true }).fill("endpoint-token");
  await page
    .getByLabel("Allowed module IDs", { exact: true })
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

async function installRemoteCapabilityViewRoutes(
  page: Page,
  remote: RemoteCapabilityServer,
): Promise<void> {
  // No `__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__` test hook: the shell's real
  // same-origin DynamicViewLoader path loads the routed bundle, appends the
  // host-external runtime query, imports the served factory module, and calls
  // its default factory with the host `react` singleton (#12250). The remote
  // server already serves the bundle in that factory shape, so this exercises
  // the production loading path end to end.
  await page.route(
    "**/api/views/remote-capability-live/bundle.js**",
    async (route) => {
      await fulfillRemoteCapabilityBundle(route, remote);
    },
  );
}

async function fulfillRemoteCapabilityBundle(
  route: Route,
  remote: RemoteCapabilityServer,
): Promise<void> {
  if (route.request().method() !== "GET") {
    await route.fallback();
    return;
  }

  const response = await fetch(
    `${remote.baseUrl}/assets/remote-capability-live.js`,
  );
  await route.fulfill({
    status: response.status,
    contentType:
      response.headers.get("content-type") ?? "text/javascript; charset=utf-8",
    body: await response.text(),
  });
}

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
    // Served in the new host-external factory shape: the module's default export
    // is a factory the shell's DynamicViewLoader calls with a `hostImport` that
    // resolves the host React singleton. No `globalThis` bridge (#12250).
    res.end(`
export default async function RemoteCapabilityLiveFactory(__elizaHostImport) {
  const React = await __elizaHostImport("react");
  function RemoteCapabilityLiveView(props) {
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
  return { default: RemoteCapabilityLiveView };
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
        bundleUrl: REMOTE_CAPABILITY_BUNDLE_PATH,
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

test("loads a bound frame, nested CSS/media, WASM and raw module graph in a real browser", async ({
  page,
}) => {
  const host = await fixture();
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(host.url().href);
    await page.waitForFunction(() => document.body.dataset.graph === "loaded");
    expect(
      await page
        .locator("#target")
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(11, 22, 33)");
    expect(errors).toEqual([]);
    const prefix = host
      .url()
      .pathname.slice(0, host.url().pathname.lastIndexOf("/") + 1);
    for (const file of [
      "styles/main.css",
      "media/pixel.svg",
      "main.js",
      "child.js",
      "engine.wasm",
    ])
      expect(host.requests).toContain(`${prefix}${file}`);
  } finally {
    await host.close();
  }
});

test("executes a real canonical build through the protected blob factory and rejects a relative graph before effect", async ({
  page,
}) => {
  const host = await fixture();
  try {
    const { build } = await import("vite");
    const { createViewBundleConfig } = await import(
      "../../../scripts/view-bundle-vite.config.ts"
    );
    const output = path.join(host.dir, "built");
    await mkdir(output);
    await writeFile(path.join(output, "unrelated.js"), "must not be published");
    await writeFile(
      path.join(host.dir, "entry.ts"),
      'export default async function value(){const {answer}=await import("./logic.ts");return answer}',
    );
    await writeFile(path.join(host.dir, "logic.ts"), "export const answer=42;");
    const config = createViewBundleConfig({
      packageName: "@test/assets",
      viewId: "built",
      entry: path.join(host.dir, "entry.ts"),
      outDir: output,
    });
    await build({ ...config, configFile: false, logLevel: "silent" });
    const manifest = JSON.parse(
      await fs.readFile(path.join(output, "bundle.js.assets.json"), "utf8"),
    );
    expect(manifest.files).toContain("bundle.js");
    expect(manifest.files).not.toContain("unrelated.js");
    expect(manifest.files.some((file: string) => file.endsWith(".map"))).toBe(
      false,
    );
    const plugin: Plugin = {
      name: "built-asset",
      description: "Canonical module",
      views: [{ id: "built", label: "Built", bundlePath: "built/bundle.js" }],
    };
    await registerPluginViews(host.runtime, plugin, { pluginDir: host.dir });
    const entry = getView(host.runtime, "built");
    if (!entry?.bundleUrl) throw new Error("Missing built view URL");
    const url = new URL(entry.bundleUrl, host.origin);
    url.searchParams.set("hostExternalRuntime", "1");
    url.searchParams.set("hostExternalSpecifiers", "react");
    await page.goto(host.url().href);
    // Keep the browser's native import intact; Vitest transforms imports in
    // serialized function callbacks into its Node-only SSR helper.
    const browserImport = `async (bundleUrl) => {
      const response = await fetch(bundleUrl);
      if (!response.ok) return { status: response.status, body: await response.json() };
      const objectUrl = URL.createObjectURL(new Blob([await response.text()], { type: "application/javascript" }));
      try {
        const module = await import(objectUrl);
        const exports = await module.default(async () => { throw new Error("Unexpected host import"); });
        return { status: response.status, value: await exports.default() };
      } finally { URL.revokeObjectURL(objectUrl); }
    }`;
    const result = await page.evaluate(
      `(${browserImport})(${JSON.stringify(url.href)})`,
    );
    expect(result).toEqual({ status: 200, value: 42 });
    await writeFile(
      path.join(output, "bundle.js"),
      'globalThis.unwantedEffect=true; const child=await import("./child.js"); export {child};',
    );
    await writeFile(path.join(output, "child.js"), "export const value=1;");
    await writeFile(
      path.join(output, "bundle.js.assets.json"),
      JSON.stringify({ version: 1, files: ["bundle.js", "child.js"] }),
    );
    await registerPluginViews(host.runtime, plugin, { pluginDir: host.dir });
    const rejected = new URL(
      getView(host.runtime, "built")?.bundleUrl ?? "",
      host.origin,
    );
    rejected.searchParams.set("hostExternalRuntime", "1");
    rejected.searchParams.set("hostExternalSpecifiers", "react");
    const rejectedLoad = await page.evaluate(
      `(${browserImport})(${JSON.stringify(rejected.href)})`,
    );
    expect(rejectedLoad).toMatchObject({
      status: 422,
      body: { code: "VIEW_MODULE_GRAPH_UNSUPPORTED" },
    });
    expect(await page.evaluate(() => "unwantedEffect" in globalThis)).toBe(
      false,
    );
  } finally {
    await host.close();
  }
});
