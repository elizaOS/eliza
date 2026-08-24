/** Exercises dynamic-views singleton wiring with a recording canvas and real temp-file entrypoints. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getDynamicViewRegistry,
  getDynamicViewSessionManager,
  registerBuiltInDynamicViews,
  resetDynamicViewStateForTests,
} from "./index";
import type { DynamicViewManifest } from "./types";

type SessionManagerOptions = Parameters<typeof getDynamicViewSessionManager>[0];
type CanvasContract = SessionManagerOptions["canvas"];
type CreateWindowOptions = Parameters<CanvasContract["createWindow"]>[0];

const BUILT_IN_ID = "agent.run.trace.demo";
const FIXTURE_ENTRYPOINT = "fixture-view.html";

interface RecordingCanvas extends CanvasContract {
  calls: string[];
  creates: CreateWindowOptions[];
  pushedWindowIds: string[];
  destroyedWindowIds: string[];
}

function recordingCanvas(label: string): RecordingCanvas {
  const canvas = {
    calls: [] as string[],
    creates: [] as CreateWindowOptions[],
    pushedWindowIds: [] as string[],
    destroyedWindowIds: [] as string[],
    async createWindow(options: CreateWindowOptions) {
      const id = `${label}-window-${canvas.calls.length + 1}`;
      canvas.calls.push(`create:${id}`);
      canvas.creates.push(options);
      return { id };
    },
    async destroyWindow(options: { id: string }) {
      canvas.calls.push(`destroy:${options.id}`);
      canvas.destroyedWindowIds.push(options.id);
    },
    async a2uiPush(message: { id: string }) {
      canvas.calls.push(`push:${message.id}`);
      canvas.pushedWindowIds.push(message.id);
    },
  };
  return canvas;
}

function fixtureManifest(id: string): DynamicViewManifest {
  return {
    id,
    title: `View ${id}`,
    source: "developer",
    entrypoint: `./${FIXTURE_ENTRYPOINT}`,
    placement: "floating",
  };
}

describe("dynamic-views singleton surface", () => {
  let entrypointBaseDir = "";

  beforeAll(async () => {
    entrypointBaseDir = await mkdtemp(
      path.join(tmpdir(), "eliza-dynamic-views-index-"),
    );
    await writeFile(
      path.join(entrypointBaseDir, FIXTURE_ENTRYPOINT),
      "<!doctype html><html><body>fixture</body></html>",
    );
  });

  afterAll(async () => {
    if (entrypointBaseDir) {
      await rm(entrypointBaseDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    resetDynamicViewStateForTests();
  });

  describe("getDynamicViewRegistry", () => {
    it("returns the same shared registry instance across calls", () => {
      const first = getDynamicViewRegistry();
      const second = getDynamicViewRegistry();

      expect(second).toBe(first);
    });

    it("exposes mutations to every caller of the shared registry", () => {
      const writer = getDynamicViewRegistry();
      const reader = getDynamicViewRegistry();

      writer.register(fixtureManifest("shared.view"));

      expect(reader.get("shared.view")?.title).toBe("View shared.view");
      expect(reader.list()).toHaveLength(1);
    });

    it("keeps the registry identity after reset while emptying it", () => {
      const registry = getDynamicViewRegistry();
      registry.register(fixtureManifest("reset.me"));

      resetDynamicViewStateForTests();

      expect(getDynamicViewRegistry()).toBe(registry);
      expect(registry.list()).toHaveLength(0);
      expect(registry.get("reset.me")).toBeNull();
    });
  });

  describe("getDynamicViewSessionManager", () => {
    it("lazily constructs one manager and ignores later differing options", async () => {
      const firstCanvas = recordingCanvas("first");
      const first = getDynamicViewSessionManager({
        registry: getDynamicViewRegistry(),
        canvas: firstCanvas,
        entrypointBaseDir,
      });
      const secondCanvas = recordingCanvas("second");
      const again = getDynamicViewSessionManager({
        registry: getDynamicViewRegistry(),
        canvas: secondCanvas,
        entrypointBaseDir,
      });

      expect(again).toBe(first);

      getDynamicViewRegistry().register(fixtureManifest("routed.view"));
      const opened = await again.open({ viewId: "routed.view" });

      expect(opened.status).toBe("open");
      expect(opened.viewId).toBe("routed.view");
      expect(opened.canvasWindowId).toBe(
        firstCanvas.calls[0]?.slice("create:".length),
      );
      expect(firstCanvas.creates[0]?.url).toContain(FIXTURE_ENTRYPOINT);
      expect(firstCanvas.creates[0]?.alwaysOnTop).toBe(true);
      expect(firstCanvas.pushedWindowIds).toEqual([opened.canvasWindowId]);
      expect(secondCanvas.calls).toEqual([]);
    });

    it("constructs a fresh manager with new options after reset", async () => {
      const staleCanvas = recordingCanvas("stale");
      const stale = getDynamicViewSessionManager({
        registry: getDynamicViewRegistry(),
        canvas: staleCanvas,
        entrypointBaseDir,
      });

      resetDynamicViewStateForTests();

      const freshCanvas = recordingCanvas("fresh");
      const fresh = getDynamicViewSessionManager({
        registry: getDynamicViewRegistry(),
        canvas: freshCanvas,
        entrypointBaseDir,
      });

      expect(fresh).not.toBe(stale);
      expect(fresh.list()).toEqual([]);

      getDynamicViewRegistry().register(fixtureManifest("fresh.route"));
      const opened = await fresh.open({ viewId: "fresh.route" });

      expect(opened.status).toBe("open");
      expect(freshCanvas.calls.length).toBeGreaterThan(0);
      expect(staleCanvas.calls).toEqual([]);
    });
  });

  describe("registerBuiltInDynamicViews", () => {
    it("registers the canonical built-in demo manifest exactly once", () => {
      const registered = registerBuiltInDynamicViews();

      const demo = getDynamicViewRegistry().get(BUILT_IN_ID);
      expect(demo).toEqual({
        id: BUILT_IN_ID,
        title: "Agent Run Trace Demo",
        description: "Developer demo for agent-created dynamic views.",
        source: "developer",
        entrypoint: "./demo/agent-run-trace.html",
        placement: "floating",
        metadata: { demo: true },
      });
      expect(registered).toContainEqual(demo);

      const reregistered = registerBuiltInDynamicViews();
      expect(
        reregistered.filter((manifest) => manifest.id === BUILT_IN_ID),
      ).toHaveLength(1);
    });

    it("replaces a colliding pre-registered manifest with canonical values", () => {
      getDynamicViewRegistry().register({
        id: BUILT_IN_ID,
        title: "Hijacked Demo",
        source: "plugin",
        entrypoint: "./hijacked.html",
        placement: "panel",
      });

      registerBuiltInDynamicViews();

      const demo = getDynamicViewRegistry().get(BUILT_IN_ID);
      expect(demo?.title).toBe("Agent Run Trace Demo");
      expect(demo?.source).toBe("developer");
      expect(demo?.placement).toBe("floating");
      expect(demo?.entrypoint).toBe("./demo/agent-run-trace.html");
      expect(demo?.metadata).toEqual({ demo: true });
    });

    it("keeps unrelated manifests and reports them beside the built-in", () => {
      const registry = getDynamicViewRegistry();
      registry.register(fixtureManifest("other.one"));
      registry.register(fixtureManifest("other.two"));

      const registered = registerBuiltInDynamicViews();
      const ids = registered.map((manifest) => manifest.id);

      expect(ids).toContain("other.one");
      expect(ids).toContain("other.two");
      expect(ids).toContain(BUILT_IN_ID);
      expect(registry.get("other.one")).not.toBeNull();
      expect(registry.get("other.two")).not.toBeNull();
    });

    it("returns the live registry list without re-registering once flagged", () => {
      registerBuiltInDynamicViews();
      expect(getDynamicViewRegistry().unregister(BUILT_IN_ID)).toBe(true);

      const listed = registerBuiltInDynamicViews();

      expect(listed.some((manifest) => manifest.id === BUILT_IN_ID)).toBe(
        false,
      );
      expect(getDynamicViewRegistry().get(BUILT_IN_ID)).toBeNull();
    });

    it("can register the built-in again after a reset", () => {
      registerBuiltInDynamicViews();
      resetDynamicViewStateForTests();
      expect(getDynamicViewRegistry().list()).toEqual([]);

      const registered = registerBuiltInDynamicViews();

      expect(getDynamicViewRegistry().get(BUILT_IN_ID)?.title).toBe(
        "Agent Run Trace Demo",
      );
      expect(registered).toContainEqual(
        getDynamicViewRegistry().get(BUILT_IN_ID),
      );
    });
  });

  describe("resetDynamicViewStateForTests", () => {
    it("removes every manifest including several custom ones", () => {
      const registry = getDynamicViewRegistry();
      registerBuiltInDynamicViews();
      registry.register(fixtureManifest("custom.a"));
      registry.register(fixtureManifest("custom.b"));

      resetDynamicViewStateForTests();

      expect(registry.list()).toEqual([]);
      expect(registry.get(BUILT_IN_ID)).toBeNull();
      expect(registry.get("custom.a")).toBeNull();
      expect(registry.get("custom.b")).toBeNull();
    });

    it("is idempotent on already-empty state", () => {
      expect(() => {
        resetDynamicViewStateForTests();
        resetDynamicViewStateForTests();
      }).not.toThrow();

      const registry = getDynamicViewRegistry();
      registry.register(fixtureManifest("post.reset"));
      expect(registry.get("post.reset")).not.toBeNull();
    });
  });
});
