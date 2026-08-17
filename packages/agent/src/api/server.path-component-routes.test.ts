/**
 * Boots the real TCP API host with a deterministic browser-plugin boundary to
 * prove host-owned browser package/workspace path segments reject malformed
 * encoding before browser operations and decode valid values exactly once.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const browserMocks = vi.hoisted(() => ({
  buildPackage: vi.fn(async (browser: string) => ({ browser, built: true })),
  closeTab: vi.fn(async () => true),
  getPackageStatus: vi.fn(() => ({ ready: true })),
  getWorkspaceSnapshot: vi.fn(async () => ({ mode: "web", tabs: [] })),
  openManager: vi.fn(async (browser: string) => ({ browser, opened: true })),
}));

vi.mock("@elizaos/plugin-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/plugin-browser")>()),
  __mobileStub: false,
  BROWSER_BRIDGE_KINDS: ["chrome", "safari"],
  BROWSER_BRIDGE_PACKAGE_PATH_TARGETS: ["chrome-build"],
  buildBrowserBridgeCompanionPackage: browserMocks.buildPackage,
  closeBrowserWorkspaceTab: browserMocks.closeTab,
  getBrowserBridgeCompanionPackageStatus: browserMocks.getPackageStatus,
  getBrowserWorkspaceSnapshot: browserMocks.getWorkspaceSnapshot,
  openBrowserBridgeCompanionManager: browserMocks.openManager,
}));

import { startApiServer } from "./server.ts";

const MALFORMED_COMPONENTS = [
  "%",
  "%2",
  "%ZZ",
  "%E0%A4",
  "%ED%A0%80",
  "%C0%80",
] as const;

const TOKEN = "path-component-route-test";
const touchedEnv = [
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DEVICE_BRIDGE_ENABLED",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PLATFORM",
  "ELIZA_STATE_DIR",
] as const;
const originalEnv = new Map<string, string | undefined>();

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;
let api: ApiServer;
let root: string;

async function request(pathname: string, method: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${api.port}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

beforeAll(async () => {
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
  root = await mkdtemp(path.join(tmpdir(), "eliza-path-component-routes-"));
  const configPath = path.join(root, "eliza.json");
  await writeFile(configPath, JSON.stringify({ logging: { level: "fatal" } }));
  process.env.ELIZA_STATE_DIR = root;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = TOKEN;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
  delete process.env.ELIZA_PLATFORM;
  api = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await api?.close();
  await rm(root, { recursive: true, force: true });
  for (const key of touchedEnv) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("host browser route path-component decoding", () => {
  for (const malformed of MALFORMED_COMPONENTS) {
    for (const route of [
      {
        label: "package build browser",
        method: "POST",
        path: `/api/browser-bridge/packages/${malformed}/build`,
        error: "Invalid browser bridge package browser: malformed URL encoding",
      },
      {
        label: "package manager browser",
        method: "POST",
        path: `/api/browser-bridge/packages/${malformed}/open-manager`,
        error: "Invalid browser bridge package browser: malformed URL encoding",
      },
      {
        label: "workspace tab id",
        method: "DELETE",
        path: `/api/browser-workspace/tabs/${malformed}`,
        error: "Invalid browser workspace tab id: malformed URL encoding",
      },
    ]) {
      it(`rejects malformed ${route.label} ${malformed} before browser work`, async () => {
        const response = await request(route.path, route.method);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: route.error });
        expect(browserMocks.buildPackage).not.toHaveBeenCalled();
        expect(browserMocks.openManager).not.toHaveBeenCalled();
        expect(browserMocks.closeTab).not.toHaveBeenCalled();
      });
    }
  }

  it("decodes a valid package-build browser before dispatch", async () => {
    const response = await request(
      "/api/browser-bridge/packages/%63hrome/build",
      "POST",
    );

    expect(response.status).toBe(200);
    expect(browserMocks.buildPackage).toHaveBeenCalledWith("chrome");
  });

  it("decodes a valid package-manager browser before dispatch", async () => {
    const response = await request(
      "/api/browser-bridge/packages/%73afari/open-manager",
      "POST",
    );

    expect(response.status).toBe(200);
    expect(browserMocks.openManager).toHaveBeenCalledWith("safari");
  });

  it("decodes a valid workspace tab id before dispatch", async () => {
    const response = await request("/api/browser-workspace/tabs/%61", "DELETE");

    expect(response.status).toBe(200);
    expect(browserMocks.closeTab).toHaveBeenCalledWith("a");
  });

  it("decodes an encoded slash in a workspace tab only after routing", async () => {
    const response = await request("/api/browser-workspace/tabs/%2F", "DELETE");

    expect(response.status).toBe(200);
    expect(browserMocks.closeTab).toHaveBeenCalledWith("/");
  });

  it("does not decode a workspace tab id twice", async () => {
    const response = await request(
      "/api/browser-workspace/tabs/%2561",
      "DELETE",
    );

    expect(response.status).toBe(200);
    expect(browserMocks.closeTab).toHaveBeenCalledWith("%61");
  });
});
