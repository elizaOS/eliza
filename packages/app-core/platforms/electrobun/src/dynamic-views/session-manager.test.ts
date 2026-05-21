import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
import { DynamicViewError } from "./errors";
import { DynamicViewRegistry } from "./registry";
import { DynamicViewSessionManager } from "./session-manager";
import type { DynamicViewManifest } from "./types";

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

class FakeWorkerStatusProvider {
  constructor(private readonly states: Record<string, string>) {}

  getWorkerStatus(id: string): { state: string } | null {
    const state = this.states[id];
    return state ? { state } : null;
  }
}

function manifest(entrypoint: string): DynamicViewManifest {
  return {
    id: "agent.run.trace",
    title: "Agent Run Trace",
    source: "agent",
    entrypoint,
    placement: "floating",
    requiredRemotes: ["eliza.runtime"],
    eventSubscriptions: [{ remoteId: "eliza.runtime" }],
    invokeTargets: ["eliza.runtime"],
  };
}

function withTempView<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), "dynamic-view-"));
  try {
    writeFileSync(
      join(dir, "trace.html"),
      "<!doctype html><title>trace</title>",
    );
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("DynamicViewSessionManager", () => {
  it("opens a registered view through canvas and pushes initial state", () =>
    withTempView(async (dir) => {
      const registry = new DynamicViewRegistry();
      registry.register(manifest("trace.html"));
      const canvas = new FakeCanvas();
      const sessions = new DynamicViewSessionManager({
        registry,
        canvas,
        workerStatusProvider: new FakeWorkerStatusProvider({
          "eliza.runtime": "running",
        }),
        now: () => new Date("2026-05-17T12:00:00.000Z"),
        sessionIdFactory: () => "session-1",
        entrypointBaseDir: dir,
      });

      const session = await sessions.open({
        viewId: "agent.run.trace",
        initialState: { runId: "run-1" },
      });

      expect(session.status).toBe("open");
      expect(session.canvasWindowId).toBe("canvas-1");
      expect(canvas.windows[0].title).toBe("Agent Run Trace");
      expect(canvas.windows[0].url).toContain("trace.html");
      expect(canvas.pushes[0].payload).toMatchObject({
        type: "dynamic-view.session.opened",
        sessionId: "dynamic-view-session-1",
        initialState: { runId: "run-1" },
      });
    }));

  it("rejects missing required Remotes", () =>
    withTempView(async (dir) => {
      const registry = new DynamicViewRegistry();
      registry.register(manifest("trace.html"));
      const sessions = new DynamicViewSessionManager({
        registry,
        canvas: new FakeCanvas(),
        workerStatusProvider: new FakeWorkerStatusProvider({
          "eliza.runtime": "stopped",
        }),
        entrypointBaseDir: dir,
      });

      await expect(
        sessions.open({ viewId: "agent.run.trace" }),
      ).rejects.toMatchObject({
        code: "DYNAMIC_VIEW_REQUIRED_REMOTE_UNAVAILABLE",
      });
    }));

  it("pushes events and closes sessions", () =>
    withTempView(async (dir) => {
      const registry = new DynamicViewRegistry();
      registry.register(manifest("trace.html"));
      const canvas = new FakeCanvas();
      const sessions = new DynamicViewSessionManager({
        registry,
        canvas,
        workerStatusProvider: new FakeWorkerStatusProvider({
          "eliza.runtime": "running",
        }),
        entrypointBaseDir: dir,
        sessionIdFactory: () => "session-2",
      });
      const session = await sessions.open({ viewId: "agent.run.trace" });

      await sessions.push({
        sessionId: session.sessionId,
        event: "trace.event",
        payload: { ok: true },
      });
      const closed = await sessions.close({ sessionId: session.sessionId });

      expect(canvas.pushes[1].payload).toMatchObject({
        type: "dynamic-view.event",
        event: "trace.event",
        payload: { ok: true },
      });
      expect(closed.status).toBe("closed");
      expect(canvas.destroyed).toEqual(["canvas-1"]);
    }));

  it("rejects missing manifests", async () => {
    const sessions = new DynamicViewSessionManager({
      registry: new DynamicViewRegistry(),
      canvas: new FakeCanvas(),
    });

    await expect(sessions.open({ viewId: "missing" })).rejects.toBeInstanceOf(
      DynamicViewError,
    );
  });
});
