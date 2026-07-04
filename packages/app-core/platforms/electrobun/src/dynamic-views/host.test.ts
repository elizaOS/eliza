/** Exercises host behavior with deterministic app-core test fixtures. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
import { DynamicViewError } from "./errors";
import { createDynamicViewHost } from "./host";
import { DynamicViewRegistry } from "./registry";
import { DynamicViewSessionManager } from "./session-manager";

class FakeCanvas {
  readonly windows: Array<{ id: string; url?: string; title?: string }> = [];
  readonly pushes: Array<{ id: string; payload: JsonValue }> = [];
  readonly destroyed: string[] = [];

  async createWindow(options: {
    url?: string;
    title?: string;
  }): Promise<{ id: string }> {
    const id = `canvas-${this.windows.length + 1}`;
    this.windows.push({ id, url: options.url, title: options.title });
    return { id };
  }

  async destroyWindow(options: { id: string }): Promise<void> {
    this.destroyed.push(options.id);
  }

  async a2uiPush(options: { id: string; payload: JsonValue }): Promise<void> {
    this.pushes.push(options);
  }
}

function hostFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-view-host-"));
  writeFileSync(join(dir, "trace.html"), "<!doctype html><title>trace</title>");
  const registry = new DynamicViewRegistry();
  const canvas = new FakeCanvas();
  const sessions = new DynamicViewSessionManager({
    registry,
    canvas,
    entrypointBaseDir: dir,
    sessionIdFactory: () => "session-1",
    now: () => new Date("2026-05-17T12:00:00.000Z"),
  });
  const host = createDynamicViewHost({ registry, sessions });
  return {
    canvas,
    host,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function registerParams(title = "Trace View") {
  return {
    manifest: {
      id: "agent.run.trace",
      title,
      source: "agent",
      entrypoint: "trace.html",
      placement: "floating",
      description: "Trace the active agent run",
      permissions: ["filesystem.read"],
      requiredRemotes: [],
      eventSubscriptions: [{ remoteId: "eliza.runtime", events: ["ready"] }],
      invokeTargets: ["eliza.runtime"],
      metadata: { test: true },
    },
  };
}

describe("DynamicViewHost", () => {
  it("registers, updates, lists, opens, pushes, closes, and unregisters a view", async () => {
    const fixture = hostFixture();
    try {
      const registered = await fixture.host.register(registerParams());
      expect(registered).toMatchObject({
        id: "agent.run.trace",
        title: "Trace View",
        requiredRemotes: [],
        eventSubscriptions: [{ remoteId: "eliza.runtime", events: ["ready"] }],
      });

      const updated = await fixture.host.register({
        ...registerParams("Edited Trace View"),
        update: true,
      });
      expect(updated).toMatchObject({ title: "Edited Trace View" });

      await expect(fixture.host.list()).resolves.toMatchObject({
        views: [expect.objectContaining({ id: "agent.run.trace" })],
      });

      const opened = await fixture.host.open({
        viewId: "agent.run.trace",
        title: "Runtime Trace",
        placement: "debug",
        initialState: { runId: "run-1" },
        metadata: { openedBy: "test" },
      });
      expect(opened).toMatchObject({
        sessionId: "dynamic-view-session-1",
        viewId: "agent.run.trace",
        title: "Runtime Trace",
        placement: "debug",
        status: "open",
        metadata: {
          openedBy: "test",
          initialState: { runId: "run-1" },
        },
      });
      expect(fixture.canvas.windows[0]).toMatchObject({
        id: "canvas-1",
        title: "Runtime Trace",
      });

      await expect(
        fixture.host.push({
          sessionId: "dynamic-view-session-1",
          event: "trace.updated",
          payload: { step: 2 },
        }),
      ).resolves.toEqual({ ok: true });

      await expect(fixture.host.sessions()).resolves.toMatchObject({
        sessions: [
          expect.objectContaining({
            sessionId: "dynamic-view-session-1",
            status: "open",
          }),
        ],
      });

      await expect(
        fixture.host.close({ sessionId: "dynamic-view-session-1" }),
      ).resolves.toMatchObject({
        sessionId: "dynamic-view-session-1",
        status: "closed",
      });
      expect(fixture.canvas.destroyed).toEqual(["canvas-1"]);

      await expect(
        fixture.host.unregister({ viewId: "agent.run.trace" }),
      ).resolves.toEqual({ removed: true });
      await expect(fixture.host.list()).resolves.toEqual({ views: [] });
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["register params", () => undefined, "dynamic-view-register"],
    ["register manifest", () => ({ manifest: null }), "dynamic-view-register"],
    [
      "register source",
      () => ({
        manifest: { ...registerParams().manifest, source: "outside" },
      }),
      "dynamic-view-register",
    ],
    [
      "register subscriptions",
      () => ({
        manifest: {
          ...registerParams().manifest,
          eventSubscriptions: [{ remoteId: "" }],
        },
      }),
      "dynamic-view-register",
    ],
    [
      "register subscription entry",
      () => ({
        manifest: {
          ...registerParams().manifest,
          eventSubscriptions: ["not-an-object"],
        },
      }),
      "dynamic-view-register",
    ],
    [
      "register metadata array",
      () => ({
        manifest: { ...registerParams().manifest, metadata: ["bad"] },
      }),
      "dynamic-view-register",
    ],
    [
      "register metadata null",
      () => ({
        manifest: { ...registerParams().manifest, metadata: null },
      }),
      "dynamic-view-register",
    ],
    ["unregister viewId", () => ({ viewId: "" }), "dynamic-view-unregister"],
    ["open viewId", () => ({ viewId: "" }), "dynamic-view-open"],
    [
      "open placement",
      () => ({ viewId: "agent.run.trace", placement: "sidebar" }),
      "dynamic-view-open",
    ],
    [
      "open metadata array",
      () => ({
        viewId: "agent.run.trace",
        metadata: ["bad"],
      }),
      "dynamic-view-open",
    ],
    [
      "open metadata null",
      () => ({
        viewId: "agent.run.trace",
        metadata: null,
      }),
      "dynamic-view-open",
    ],
    ["close sessionId", () => ({ sessionId: "" }), "dynamic-view-close"],
    ["push event", () => ({ sessionId: "s", event: "" }), "dynamic-view-push"],
  ])("validates host JSON params: %s", async (_name, params, method) => {
    const fixture = hostFixture();
    try {
      const call =
        method === "dynamic-view-register"
          ? fixture.host.register
          : method === "dynamic-view-unregister"
            ? fixture.host.unregister
            : method === "dynamic-view-open"
              ? fixture.host.open
              : method === "dynamic-view-close"
                ? fixture.host.close
                : fixture.host.push;

      await expect(call(params() as JsonValue)).rejects.toMatchObject({
        code: "DYNAMIC_VIEW_INVALID_MANIFEST",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("serializes omitted optional manifest and session fields deterministically", async () => {
    const fixture = hostFixture();
    try {
      const registered = await fixture.host.register({
        manifest: {
          id: "agent.minimal",
          title: "Minimal View",
          source: "agent",
          entrypoint: "trace.html",
          placement: "floating",
        },
      });

      expect(registered).toEqual({
        id: "agent.minimal",
        title: "Minimal View",
        source: "agent",
        entrypoint: "trace.html",
        placement: "floating",
        description: null,
        permissions: [],
        requiredRemotes: [],
        eventSubscriptions: [],
        invokeTargets: [],
        metadata: null,
      });

      const opened = await fixture.host.open({ viewId: "agent.minimal" });

      expect(opened).toMatchObject({
        sessionId: "dynamic-view-session-1",
        viewId: "agent.minimal",
        title: "Minimal View",
        placement: "floating",
        status: "open",
        canvasWindowId: "canvas-1",
        closedAt: null,
        error: null,
        metadata: { initialState: null },
      });
      expect(fixture.canvas.pushes[0]).toEqual({
        id: "canvas-1",
        payload: expect.objectContaining({
          type: "dynamic-view.session.opened",
          initialState: null,
          metadata: { initialState: null },
          manifest: {
            id: "agent.minimal",
            title: "Minimal View",
            source: "agent",
            placement: "floating",
            requiredRemotes: [],
            eventSubscriptions: [],
            invokeTargets: [],
          },
        }),
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("normalizes omitted push payloads to null before sending to the canvas", async () => {
    const fixture = hostFixture();
    try {
      await fixture.host.register(registerParams());
      await fixture.host.open({ viewId: "agent.run.trace" });

      await expect(
        fixture.host.push({
          sessionId: "dynamic-view-session-1",
          event: "trace.updated",
        }),
      ).resolves.toEqual({ ok: true });

      expect(fixture.canvas.pushes.at(-1)).toEqual({
        id: "canvas-1",
        payload: {
          type: "dynamic-view.event",
          sessionId: "dynamic-view-session-1",
          event: "trace.updated",
          payload: null,
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("propagates registry and session DynamicViewError codes", async () => {
    const fixture = hostFixture();
    try {
      await fixture.host.register(registerParams());

      await expect(
        fixture.host.register(registerParams()),
      ).rejects.toBeInstanceOf(DynamicViewError);
      await expect(
        fixture.host.open({ viewId: "missing" }),
      ).rejects.toMatchObject({
        code: "DYNAMIC_VIEW_NOT_FOUND",
      });
      await expect(
        fixture.host.close({ sessionId: "missing" }),
      ).rejects.toMatchObject({
        code: "DYNAMIC_VIEW_SESSION_NOT_FOUND",
      });
    } finally {
      fixture.cleanup();
    }
  });
});
