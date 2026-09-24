/** Actual authenticated loopback HTTP/WebSocket hosts share a runtime without sharing replies. */
import { on, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
} from "@elizaos/core";
import { BrowserService } from "@elizaos/plugin-browser";
import type { HttpPlugin } from "@elizaos/shared/api/http-plugin";
import { initializeTestRuntime } from "@elizaos/testing/sqlite-adapter";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { installRuntimePluginLifecycle } from "../runtime/plugin-lifecycle.ts";
import { getActiveViewContext } from "../runtime/view-action-affinity.ts";
import { startApiServer } from "./server.ts";
import { getView } from "./views-registry.ts";

type Api = Awaited<ReturnType<typeof startApiServer>>;
const token = "view-host-lifetime-fixture";

it("rejects wrong-host/client replies and preserves a peer host after close", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "view-hosts-"));
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Shared HTTP runtime" }),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  const servers: Api[] = [];
  const sockets: WebSocket[] = [];
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(dir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(dir, "eliza.json"));
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  vi.stubEnv("ELIZA_API_TOKEN", token);
  for (const key of [
    "ELIZA_API_AUTH_TOKEN",
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_REQUIRE_LOCAL_AUTH",
    "ELIZA_DEVICE_BRIDGE_ENABLED",
  ])
    vi.stubEnv(key, undefined);
  async function connect(api: Api, clientId: string) {
    const ws = new WebSocket(
      `ws://127.0.0.1:${api.port}/ws?clientId=${clientId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    sockets.push(ws);
    await once(ws, "open", { signal: AbortSignal.timeout(10_000) });
    return ws;
  }
  async function sendAndDrain(ws: WebSocket, payload: object) {
    const pong = once(ws, "pong", { signal: AbortSignal.timeout(10_000) });
    ws.send(JSON.stringify(payload));
    ws.ping();
    await pong;
  }
  async function post(
    api: Api,
    pathname: string,
    body: object,
    clientId = "same-client",
  ) {
    return fetch(`http://127.0.0.1:${api.port}${pathname}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-ElizaOS-Client-Id": clientId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }
  async function claim(api: Api, frame: Record<string, unknown>) {
    const response = await post(api, "/api/views/interact-claim", frame);
    expect(response.status).toBe(200);
    return ((await response.json()) as { claimId: string }).claimId;
  }
  function request(api: Api, ws: WebSocket) {
    const frame = (async () => {
      for await (const [bytes] of on(ws, "message", {
        signal: AbortSignal.timeout(10_000),
      })) {
        const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
        if (value.type === "view:interact") return value;
      }
      throw new Error("View socket closed without an interaction frame");
    })();
    const result = fetch(
      `http://127.0.0.1:${api.port}/api/views/host-fixture/interact`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-ElizaOS-Client-Id": "same-client",
        },
        body: JSON.stringify({ capability: "get-state", timeoutMs: 10_000 }),
        signal: AbortSignal.timeout(15_000),
      },
    ).then(async (response) => {
      expect(response.status).toBe(200);
      return response.json();
    });
    return { frame, result };
  }
  try {
    installRuntimePluginLifecycle(runtime);
    await initializeTestRuntime(runtime, { skipMigrations: true });
    class NativeBrowserService extends BrowserService {
      static override async start(owner: IAgentRuntime) {
        return new BrowserService(owner);
      }
    }
    await runtime.registerService(NativeBrowserService);
    const browser = await runtime.getServiceLoadPromise("browser");
    if (!(browser instanceof BrowserService))
      throw new Error("Browser service did not start");
    const plugin: HttpPlugin = {
      routes: [
        {
          type: "POST",
          path: "/api/host-active-elements",
          rawPath: true,
          routeHandler: async () => ({
            status: 200,
            body: { elements: getActiveViewContext(runtime)?.elements },
          }),
        },
        {
          type: "POST",
          path: "/api/host-native-navigation",
          rawPath: true,
          routeHandler: async () => ({
            status: 200,
            body: await browser.execute(
              { subaction: "navigate", url: "https://example.com/" },
              "native-client",
              "same-client",
            ),
          }),
        },
      ],
      name: "host-fixture",
      description: "Host lifetime",
      views: [
        {
          id: "host-fixture",
          label: "Host fixture",
          path: "/host-fixture",
          bundleUrl: "https://example.com/host-fixture.js",
          modalities: ["gui", "tui"],
          capabilities: [{ id: "get-state", description: "Read state" }],
        },
      ],
    };
    await runtime.registerPlugin(plugin);
    const a = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    servers.push(a);
    const b = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    servers.push(b);
    const aClient = await connect(a, "same-client");
    const bClient = await connect(b, "same-client");
    const wrongClient = await connect(a, "other-client");
    for (const platform of ["ios", "android"]) {
      const headers = {
        Authorization: `Bearer ${token}`,
        "X-Eliza-Platform": platform,
      };
      const catalog = await fetch(`http://127.0.0.1:${a.port}/api/views`, {
        headers,
      });
      expect(catalog.status).toBe(200);
      const { views } = (await catalog.json()) as {
        views: Array<Record<string, unknown>>;
      };
      const nativeBinding = views.find((view) => view.id === "host-fixture");
      expect(nativeBinding).toMatchObject({
        installationId: getView(runtime, "host-fixture")?.installationId,
        metadataOnly: true,
        available: false,
      });
      expect(nativeBinding?.bundleUrl).toBeUndefined();
      expect(nativeBinding?.frameUrl).toBeUndefined();
      for (const asset of ["bundle.js", "frame.html", "chunk.js"]) {
        const denied = await fetch(
          `http://127.0.0.1:${a.port}/api/views/host-fixture/${asset}`,
          { headers },
        );
        expect(denied.status).toBe(403);
      }
    }
    const pending = request(a, aClient);
    const frame = await pending.frame;
    expect((await post(b, "/api/views/interact-claim", frame)).status).toBe(
      409,
    );
    expect(
      (await post(a, "/api/views/interact-claim", frame, "other-client"))
        .status,
    ).toBe(409);
    const claimId = await claim(a, frame);
    expect((await post(a, "/api/views/interact-claim", frame)).status).toBe(
      409,
    );
    const reply = {
      ...frame,
      claimId,
      type: "view:interact:result",
      requestId: frame.requestId,
      success: true,
      result: { owner: "wrong" },
    };
    await sendAndDrain(bClient, reply);
    await sendAndDrain(wrongClient, reply);
    await sendAndDrain(aClient, { ...reply, result: { owner: "correct" } });
    await expect(pending.result).resolves.toMatchObject({
      success: true,
      result: { owner: "correct" },
    });
    const gui = getView(runtime, "host-fixture", { viewType: "gui" })!;
    const tui = getView(runtime, "host-fixture", { viewType: "tui" })!;
    expect(
      (
        await post(a, "/api/views/host-fixture/navigate", {
          source: "user",
          viewType: "gui",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(a, "/api/views/host-fixture/navigate", {
          source: "user",
          viewType: "tui",
        })
      ).status,
    ).toBe(200);
    const elements = [
      { id: "current-tui-control", role: "button", label: "Save" },
    ];
    const currentReport = await post(a, "/api/views/host-fixture/elements", {
      viewType: "tui",
      installationId: tui.installationId,
      elements,
    });
    await expect(currentReport.json()).resolves.toMatchObject({
      accepted: true,
    });
    const oldReport = await post(a, "/api/views/host-fixture/elements", {
      viewType: "gui",
      installationId: gui.installationId,
      elements: [{ id: "stale-gui", role: "button", label: "Old" }],
    });
    await expect(oldReport.json()).resolves.toMatchObject({ accepted: false });
    const staleGeneration = await post(a, "/api/views/host-fixture/elements", {
      viewType: "tui",
      installationId: "retired",
      elements: [],
    });
    expect(staleGeneration.status).toBe(409);
    await expect(
      (await post(a, "/api/host-active-elements", {})).json(),
    ).resolves.toMatchObject({ elements });
    aClient.terminate();
    wrongClient.terminate();
    await a.close();
    servers.splice(servers.indexOf(a), 1);
    const nativeFrames: Record<string, unknown>[] = [];
    bClient.on("message", (bytes) =>
      nativeFrames.push(JSON.parse(bytes.toString())),
    );
    const navigation = await fetch(
      `http://127.0.0.1:${b.port}/api/host-native-navigation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-ElizaOS-Client-Id": "same-client",
        },
      },
    );
    expect(navigation.status).toBe(200);
    await expect(navigation.json()).resolves.toMatchObject({
      value: { dispatched: true },
    });
    await sendAndDrain(bClient, { type: "noop" });
    expect(nativeFrames).toContainEqual(
      expect.objectContaining({
        type: "shell:navigate:view",
        viewId: "browser",
      }),
    );
    await expect(
      browser.execute(
        { subaction: "navigate", url: "https://example.com/" },
        "native-client",
        "same-client",
      ),
    ).rejects.toMatchObject({ code: "VIEW_CLIENT_REQUIRED" });
    const surviving = request(b, bClient);
    const next = await surviving.frame;
    await sendAndDrain(bClient, {
      ...next,
      claimId: await claim(b, next),
      type: "view:interact:result",
      requestId: next.requestId,
      success: true,
      result: { owner: "survivor" },
    });
    await expect(surviving.result).resolves.toMatchObject({
      success: true,
      result: { owner: "survivor" },
    });
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const api of servers) await api.close();
    await runtime.stop({ fast: true });
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
