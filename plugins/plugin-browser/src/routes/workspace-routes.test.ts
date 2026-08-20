/**
 * Browser workspace route tests for command dispatch and HTTP response mapping.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../workspace/browser-workspace.js";
import type { BrowserWorkspaceRouteContext } from "./workspace.js";
import { handleBrowserWorkspaceRoutes } from "./workspace.js";

function createJsonCapture() {
  const res: { body?: unknown; statusCode?: number } = {};
  const json = (target: typeof res, data: unknown, status = 200): void => {
    target.statusCode = status;
    target.body = data;
  };
  return { json, res };
}

function buildCtx(args: {
  method: string;
  pathname: string;
  body?: unknown;
  url?: URL;
}): {
  ctx: BrowserWorkspaceRouteContext;
  res: ReturnType<typeof createJsonCapture>["res"];
} {
  const { json, res } = createJsonCapture();
  const ctx: BrowserWorkspaceRouteContext = {
    req: {} as BrowserWorkspaceRouteContext["req"],
    res: res as BrowserWorkspaceRouteContext["res"],
    method: args.method,
    pathname: args.pathname,
    url: args.url ?? new URL(`http://local${args.pathname}`),
    state: { runtime: null },
    readJsonBody: vi.fn(async () => args.body ?? null),
    json: json as BrowserWorkspaceRouteContext["json"],
    error: vi.fn(),
    decodePathComponent(value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    },
  };
  return { ctx, res };
}

describe("browser workspace HTTP routes", () => {
  const originalWorkspaceUrl = process.env.ELIZA_BROWSER_WORKSPACE_URL;

  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  afterEach(() => {
    if (originalWorkspaceUrl === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_URL = originalWorkspaceUrl;
    }
    vi.unstubAllGlobals();
  });

  it("returns the workspace snapshot", async () => {
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/browser-workspace",
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      mode: expect.any(String),
      tabs: expect.any(Array),
    });
  });

  it("rejects commands missing subaction", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: {},
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "subaction is required" });
  });

  it("normalizes an operation-only command past subaction validation", async () => {
    // Regression (#22194): the route validated `subaction` before
    // normalization, so a documented `operation` alias with no `subaction`
    // was rejected with 400 instead of resolving and reaching the executor.
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: { operation: "navigate", url: "about:blank" },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    // No current tab exists, so the normalized `navigate` reaches the executor
    // and surfaces the target-missing contract rather than a 400.
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: "target_missing",
      error: expect.stringContaining("requires a current tab"),
    });
  });

  it("rejects a whitespace-only subaction with 400", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: { subaction: "   " },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "subaction is required" });
  });

  it("rejects non-object command payloads", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: ["state"],
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "request body must be a JSON object" });
  });

  it.each([
    [null, "command.steps[0] must be a JSON object"],
    ["click", "command.steps[0] must be a JSON object"],
    [42, "command.steps[0] must be a JSON object"],
    [true, "command.steps[0] must be a JSON object"],
    [[], "command.steps[0] must be a JSON object"],
  ])("rejects a malformed batch step %# as a 400", async (step, error) => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: { subaction: "batch", steps: [step] },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error });
  });

  it("rejects sparse and deeply nested malformed batch steps as a 400", async () => {
    const sparseSteps = new Array(1);
    const malformedBodies = [
      { subaction: "batch", steps: sparseSteps },
      {
        subaction: "batch",
        steps: [{ subaction: "batch", steps: [null] }],
      },
      { subaction: "batch", steps: "not-an-array" },
    ];

    for (const body of malformedBodies) {
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: "/api/browser-workspace/command",
        body,
      });

      await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringMatching(/^command(?:\.steps\[\d+\])?\.steps/),
      });
    }
  });

  it.each([{}, { operation: 42 }, { subaction: "   " }])(
    "rejects a nested command missing a usable subaction",
    async (step) => {
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: "/api/browser-workspace/command",
        body: { subaction: "batch", steps: [step] },
      });

      await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: "command.steps[0].subaction is required",
      });
    },
  );

  it("rejects excessive command nesting before recursive normalization", async () => {
    let nested: Record<string, unknown> = { subaction: "list" };
    for (let depth = 0; depth < 33; depth += 1) {
      nested = { subaction: "batch", steps: [nested] };
    }
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: nested,
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: expect.stringContaining("exceeds the maximum nesting depth of 32"),
    });
  });

  it("accepts exactly 256 total commands through the real route", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: {
        subaction: "batch",
        steps: Array.from({ length: 255 }, () => ({ operation: "list" })),
      },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      subaction: "batch",
    });
    const steps = (res.body as { steps: Array<{ subaction: string }> }).steps;
    expect(steps).toHaveLength(255);
    expect(steps.every((step) => step.subaction === "list")).toBe(true);
  });

  it("rejects 257 total commands before gating or execution", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: {
        subaction: "batch",
        connectorProvider: "would-require-a-runtime-if-gating-ran",
        connectorAccountId: "untrusted",
        steps: Array.from({ length: 256 }, () => ({ operation: "list" })),
      },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "command tree exceeds the maximum of 256 commands",
    });
  });

  it("applies the 256-command cap across nested batches", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: {
        subaction: "batch",
        steps: [
          {
            subaction: "batch",
            steps: Array.from({ length: 127 }, () => ({ operation: "list" })),
          },
          {
            subaction: "batch",
            steps: Array.from({ length: 127 }, () => ({ operation: "list" })),
          },
        ],
      },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "command tree exceeds the maximum of 256 commands",
    });
  });

  it.each([
    { subaction: "batch" },
    { subaction: "batch", steps: [] },
    {
      subaction: "batch",
      steps: [{ operation: "batch" }],
    },
  ])("rejects missing or empty batch steps as a 400", async (body) => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body,
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: expect.stringMatching(
        /\.steps must contain at least one command$/,
      ),
    });
  });

  it("preserves operation aliases and valid nested batch execution", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: {
        operation: "batch",
        steps: [
          { operation: "batch", steps: [{ operation: "list" }] },
          { subaction: " LIST " },
        ],
      },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      subaction: "batch",
      steps: [
        { subaction: "batch", steps: [{ subaction: "list" }] },
        { subaction: "list" },
      ],
    });
  });

  it("rejects malformed encoded tab ids as a 400", async () => {
    const { ctx, res } = buildCtx({
      method: "DELETE",
      pathname: "/api/browser-workspace/tabs/%",
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "valid tab id is required" });
  });

  it("rejects blank decoded tab ids as a 400", async () => {
    const { ctx, res } = buildCtx({
      method: "DELETE",
      pathname: "/api/browser-workspace/tabs/%20%20",
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "valid tab id is required" });
  });

  it("rejects non-object tab creation payloads", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/tabs",
      body: "about:blank",
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "request body must be a JSON object" });
  });

  it("returns 404 when closing a missing tab", async () => {
    const { ctx, res } = buildCtx({
      method: "DELETE",
      pathname: "/api/browser-workspace/tabs/missing-tab",
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ closed: false });
  });

  it("rejects navigate requests without a URL", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/tabs/tab-1/navigate",
      body: {},
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "url is required" });
  });

  it("rejects malformed navigate payloads before tab access", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/tabs/missing-tab/navigate",
      body: [],
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "request body must be a JSON object" });
  });

  it("returns 503 when events bridge is unavailable", async () => {
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/browser-workspace/events",
      url: new URL("http://local/api/browser-workspace/events?after=1"),
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      code: "desktop_only",
      error: expect.stringContaining("browser workspace desktop bridge"),
    });
  });

  it("preserves desktop bridge HTTP statuses on structured errors", async () => {
    process.env.ELIZA_BROWSER_WORKSPACE_URL = "http://workspace-bridge.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("locked", { status: 409 })),
    );
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/browser-workspace/events",
      url: new URL("http://local/api/browser-workspace/events?after=1"),
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: "command_failed",
      error: expect.stringContaining("failed (409): locked"),
    });
  });

  it("returns structured browser workspace error codes from command failures", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/browser-workspace/command",
      body: { subaction: "navigate", url: "about:blank" },
    });

    await expect(handleBrowserWorkspaceRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: "target_missing",
      error: expect.stringContaining("requires a current tab"),
    });
  });

  it("preserves history direction and truncates forward history after a new navigation", async () => {
    const tab = await openBrowserWorkspaceTab({
      show: true,
      url: "about:blank",
    });
    await executeBrowserWorkspaceCommand({
      id: tab.id,
      networkAction: "route",
      responseBody: "<!doctype html><title>Loaded</title>",
      subaction: "network",
      url: "**",
    });

    await executeBrowserWorkspaceCommand({
      id: tab.id,
      subaction: "navigate",
      url: "https://example.com/first",
    });
    await executeBrowserWorkspaceCommand({
      id: tab.id,
      subaction: "navigate",
      url: "https://example.com/second",
    });

    const back = await executeBrowserWorkspaceCommand({
      id: tab.id,
      subaction: "back",
    });
    expect(back.value).toMatchObject({
      changed: true,
      url: "https://example.com/first",
    });

    await executeBrowserWorkspaceCommand({
      id: tab.id,
      subaction: "navigate",
      url: "https://example.com/branch",
    });
    const forward = await executeBrowserWorkspaceCommand({
      id: tab.id,
      subaction: "forward",
    });

    expect(forward.value).toMatchObject({
      changed: false,
      url: "https://example.com/branch",
    });
  });

  it("round trips web user state without leaking across later mutations", async () => {
    const dir = await fsp.mkdtemp(
      path.join(process.cwd(), "plugin-browser-state-"),
    );
    try {
      const statePath = path.join(dir, "browser-state.json");
      const tab = await openBrowserWorkspaceTab({
        show: true,
        url: "about:blank",
      });
      await executeBrowserWorkspaceCommand({
        id: tab.id,
        networkAction: "route",
        responseBody: "<!doctype html><title>State</title>",
        subaction: "network",
        url: "**",
      });
      await executeBrowserWorkspaceCommand({
        id: tab.id,
        subaction: "navigate",
        url: "https://example.com/state",
      });

      await executeBrowserWorkspaceCommand({
        clipboardAction: "write",
        id: tab.id,
        subaction: "clipboard",
        value: "saved clipboard",
      });
      await executeBrowserWorkspaceCommand({
        filePath: statePath,
        id: tab.id,
        subaction: "state",
      });
      await executeBrowserWorkspaceCommand({
        clipboardAction: "write",
        id: tab.id,
        subaction: "clipboard",
        value: "mutated clipboard",
      });

      await executeBrowserWorkspaceCommand({
        filePath: statePath,
        id: tab.id,
        stateAction: "load",
        subaction: "state",
      });
      const restored = await executeBrowserWorkspaceCommand({
        id: tab.id,
        subaction: "state",
      });

      expect(restored.value).toMatchObject({
        clipboard: "saved clipboard",
        url: "https://example.com/state",
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
