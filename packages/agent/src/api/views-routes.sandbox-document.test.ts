/**
 * Covers the sandboxed dynamic-view document contract (#14263). A plugin view
 * can still declare a JS bundle for host-realm dynamic loading metadata, but a
 * `surface.isolation: "sandboxed-iframe"` view must also declare a separate
 * HTML document. The registry resolves `framePath` to
 * `/api/views/:id/frame.html`, and the route serves that document directly.
 */
import { promises as fs } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getView,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

const TEST_PLUGIN = "@test/sandbox-document-view";
const VIEW_ID = "sandbox-document-view";

interface CapturedRes {
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeCtx(pathname: string, method = "GET") {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.headers = {};
  const res: CapturedRes = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  const json = vi.fn();
  const error = vi.fn();
  const ctx: ViewsRouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    method,
    pathname,
    url: new URL(`http://local${pathname}`),
    json,
    error,
    broadcastWs: vi.fn(),
  };
  return { ctx, res, json, error };
}

function statusFrom(res: CapturedRes): number | undefined {
  return res.writeHead.mock.calls[0]?.[0] as number | undefined;
}

function headersFrom(res: CapturedRes): Record<string, string | number> {
  return (res.writeHead.mock.calls[0]?.[1] ?? {}) as Record<
    string,
    string | number
  >;
}

function bodyFrom(res: CapturedRes): string {
  const chunk = res.end.mock.calls[0]?.[0];
  if (chunk instanceof Buffer) return chunk.toString("utf8");
  return typeof chunk === "string" ? chunk : "";
}

describe("GET /api/views/:id/frame.html", () => {
  let pluginDir: string | null = null;

  beforeEach(async () => {
    clearCurrentViewState();
    pluginDir = await fs.mkdtemp(path.join(tmpdir(), "eliza-sandbox-doc-"));
    await fs.mkdir(path.join(pluginDir, "dist", "views"), {
      recursive: true,
    });
    await fs.mkdir(path.join(pluginDir, "sandbox"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "dist", "views", "bundle.js"),
      "export default function View() { return null; }\n",
    );
    await fs.writeFile(
      path.join(pluginDir, "sandbox", "index.html"),
      "<!doctype html><title>Sandbox frame</title><script>parent.postMessage({ready:true}, '*')</script>",
    );

    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Synthetic sandbox frame view plugin.",
        views: [
          {
            id: VIEW_ID,
            label: "Sandbox Document View",
            path: "/apps/sandbox-document-view",
            bundlePath: "dist/views/bundle.js",
            framePath: "sandbox/index.html",
            surface: {
              isolation: "sandboxed-iframe",
              capabilities: ["navigate", "storage"],
            },
          },
        ],
      },
      pluginDir,
    );
  });

  afterEach(async () => {
    unregisterPluginViews(TEST_PLUGIN);
    clearCurrentViewState();
    if (pluginDir) {
      await fs.rm(pluginDir, { recursive: true, force: true });
      pluginDir = null;
    }
  });

  it("exposes a distinct iframe document URL in view metadata", async () => {
    const entry = getView(VIEW_ID);
    expect(entry?.bundleUrl).toMatch(
      new RegExp(`^/api/views/${VIEW_ID}/bundle\\.js\\?v=\\d+$`),
    );
    expect(entry?.frameUrl).toMatch(
      new RegExp(`^/api/views/${VIEW_ID}/frame\\.html\\?v=\\d+$`),
    );

    const { ctx, json, error } = makeCtx(
      `/api/views/${encodeURIComponent(VIEW_ID)}`,
    );
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json.mock.calls[0][1]).toMatchObject({
      id: VIEW_ID,
      surface: { isolation: "sandboxed-iframe" },
    });
    expect(json.mock.calls[0][1].frameUrl).toMatch(
      new RegExp(`^/api/views/${VIEW_ID}/frame\\.html\\?v=\\d+$`),
    );
    expect(json.mock.calls[0][1].bundleUrl).toMatch(
      new RegExp(`^/api/views/${VIEW_ID}/bundle\\.js\\?v=\\d+$`),
    );
  });

  it("serves the declared sandbox frame, not the JS bundle endpoint", async () => {
    const { ctx, res, error } = makeCtx(`/api/views/${VIEW_ID}/frame.html`);
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(statusFrom(res)).toBe(200);
    expect(headersFrom(res)).toMatchObject({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    expect(bodyFrom(res)).toContain("<title>Sandbox frame</title>");
    expect(bodyFrom(res)).not.toContain("export default function View");
  });
});
