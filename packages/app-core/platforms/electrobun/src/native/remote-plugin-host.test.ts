import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JsonValue,
  RemotePluginWorkerMessage,
} from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
import type { DynamicViewHost } from "../dynamic-views/host";
import type { TraceHost } from "../trace/trace-host-requests";
import type { VoiceHost } from "../voice/voice-host-requests";
import {
  RemotePluginHost,
  type RemotePluginWorkerHandle,
} from "./remote-plugin-host";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "electrobun-remote-plugin-host-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePayload(
  root: string,
  options: { manageRemotePlugins?: boolean } = {},
): string {
  const payloadDir = join(root, "payload");
  mkdirSync(join(payloadDir, "views"), { recursive: true });
  const grant: Record<string, boolean> = { notifications: true };
  if (options.manageRemotePlugins !== false)
    grant["manage-remote-plugins"] = true;
  writeFileSync(
    join(payloadDir, "plugin.json"),
    JSON.stringify({
      id: "bunny.search",
      name: "Search",
      version: "1.0.0",
      description: "Search helper",
      mode: "window",
      permissions: {
        host: grant,
        bun: { read: true },
      },
      view: {
        relativePath: "views/index.html",
        title: "Search",
        width: 900,
        height: 700,
      },
      worker: { relativePath: "worker.ts" },
    }),
    "utf8",
  );
  writeFileSync(join(payloadDir, "worker.ts"), "postMessage({type:'ready'});");
  writeFileSync(join(payloadDir, "views", "index.html"), "<div>Search</div>");
  return payloadDir;
}

class FakeWorkerHandle implements RemotePluginWorkerHandle {
  readonly messages: RemotePluginWorkerMessage[] = [];
  terminated = false;
  private messageListener:
    | ((message: RemotePluginWorkerMessage) => void)
    | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  postMessage(message: RemotePluginWorkerMessage): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  onMessage(listener: (message: RemotePluginWorkerMessage) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  emit(message: RemotePluginWorkerMessage): void {
    this.messageListener?.(message);
  }

  fail(message: string): void {
    this.errorListener?.(new Error(message));
  }
}

describe("RemotePluginHost", () => {
  it("installs, lists, snapshots, and uninstalls remote plugins", () =>
    withTempDir((dir) => {
      const events: string[] = [];
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        now: () => 1700000000000,
        events: {
          storeChanged: (snapshot) => {
            events.push(`store:${snapshot.remotePlugins.length}`);
          },
        },
      });

      const installed = manager.installFromDirectory({
        sourceDir: writePayload(dir),
        devMode: true,
      });

      expect(installed.id).toBe("bunny.search");
      expect(installed.sourceKind).toBe("local");
      expect(manager.listRemotePlugins()).toEqual([
        {
          id: "bunny.search",
          name: "Search",
          description: "Search helper",
          version: "1.0.0",
          mode: "window",
          permissions: [
            "host:notifications",
            "host:manage-remote-plugins",
            "bun:read",
            "isolation:shared-worker",
          ],
          status: "installed",
          devMode: true,
        },
      ]);
      expect(manager.getStoreSnapshot().remotePlugins).toHaveLength(1);

      const result = manager.uninstall("bunny.search");
      expect(result.removed).toBe(true);
      expect(result.remotePlugin?.id).toBe("bunny.search");
      expect(manager.listRemotePlugins()).toEqual([]);
      expect(events).toEqual(["store:1", "store:0"]);
    }));

  it("starts workers with init context and stops them", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const workerEvents: string[] = [];
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000 + workerEvents.length,
        events: {
          workerChanged: (status) => {
            workerEvents.push(`${status.id}:${status.state}`);
          },
        },
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });

      expect(manager.startWorker("bunny.search")).toMatchObject({
        id: "bunny.search",
        state: "running",
      });
      expect(worker.messages[0]).toMatchObject({
        type: "init",
        manifest: { id: "bunny.search" },
        context: {
          permissions: [
            "host:notifications",
            "host:manage-remote-plugins",
            "bun:read",
            "isolation:shared-worker",
          ],
        },
      });

      worker.emit({
        type: "action",
        action: "log",
        payload: { level: "info", message: "hello" },
      });
      const remotePlugin = manager.getRemotePlugin("bunny.search");
      if (!remotePlugin) throw new Error("Expected remote plugin snapshot.");
      const status = manager.stopWorker("bunny.search");
      expect(status.state).toBe("stopped");
      expect(worker.terminated).toBe(true);
      expect(
        readFileSync(
          join(dir, "store", "bunny.search", "data", "logs.txt"),
          "utf8",
        ),
      ).toBe("[info] hello\n");
      expect(manager.getLogs("bunny.search")).toMatchObject({
        id: "bunny.search",
        text: "[info] hello\n",
        truncated: false,
      });
      expect(manager.getLogs("bunny.search", 6)).toMatchObject({
        id: "bunny.search",
        text: "hello\n",
        truncated: true,
      });
      expect(workerEvents).toEqual([
        "bunny.search:starting",
        "bunny.search:running",
        "bunny.search:stopped",
      ]);
    }));

  it("records worker errors", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.fail("boom");

      expect(manager.getWorkerStatus("bunny.search")).toMatchObject({
        id: "bunny.search",
        state: "error",
        error: "boom",
      });
    }));

  it("dispatches host-request list-remote-plugins back to the worker", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "host-request",
        requestId: 1,
        method: "list-remote-plugins",
      });

      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const response = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 1,
            );
            expect(response).toBeDefined();
            expect(response).toMatchObject({
              type: "host-response",
              requestId: 1,
              success: true,
            });
            const list = (
              response as unknown as { payload: Array<{ id: string }> }
            ).payload;
            expect(list).toHaveLength(1);
            expect(list[0]).toMatchObject({ id: "bunny.search" });
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 10);
      });
    }));

  it("dispatches dynamic view host requests for trusted workers", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const opened: JsonValue[] = [];
      const dynamicViewHost: DynamicViewHost = {
        register: async () => ({ ok: true }),
        unregister: async () => ({ removed: true }),
        list: async () => ({ views: [] }),
        open: async (params) => {
          opened.push(params ?? null);
          return {
            sessionId: "session-1",
            viewId: "agent.run.trace",
            title: "Trace",
            placement: "floating",
            status: "open",
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
          };
        },
        close: async () => ({ ok: true }),
        push: async () => ({ ok: true }),
        sessions: async () => ({ sessions: [] }),
      };
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
        dynamicViewHost,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "host-request",
        requestId: 14,
        method: "dynamic-view-open",
        params: { viewId: "agent.run.trace" },
      });

      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const response = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 14,
            );
            expect(opened).toEqual([{ viewId: "agent.run.trace" }]);
            expect(response).toMatchObject({
              type: "host-response",
              requestId: 14,
              success: true,
              payload: { sessionId: "session-1" },
            });
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 10);
      });
    }));

  it("dispatches trace host requests for trusted workers", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const recorded: JsonValue[] = [];
      const traceHost: TraceHost = {
        startSession: async () => ({ id: "trace-1" }),
        completeSession: async () => ({ id: "trace-1", status: "completed" }),
        cancelSession: async () => ({ id: "trace-1", status: "cancelled" }),
        errorSession: async () => ({ id: "trace-1", status: "error" }),
        recordEvent: async (params) => {
          recorded.push(params ?? null);
          return { id: "event-1", sequence: 1 };
        },
        listSessions: async () => ({ sessions: [] }),
        getSession: async () => ({ id: "trace-1" }),
        summarizeSession: async () => ({ eventCount: 1 }),
        tailEvents: async () => ({ events: [], nextSequence: 0 }),
        searchEvents: async () => ({ events: [] }),
        openTraceView: async () => ({
          session: { id: "trace-1" },
          dynamicViewSessionId: "view-1",
        }),
      };
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
        traceHost,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "host-request",
        requestId: 15,
        method: "trace-event-record",
        params: { sessionId: "trace-1", kind: "tool.started" },
      });

      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const response = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 15,
            );
            expect(recorded).toEqual([
              { sessionId: "trace-1", kind: "tool.started" },
            ]);
            expect(response).toMatchObject({
              type: "host-response",
              requestId: 15,
              success: true,
              payload: { id: "event-1", sequence: 1 },
            });
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 10);
      });
    }));

  it("dispatches voice host requests for trusted workers", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const spoken: JsonValue[] = [];
      const synthesized: JsonValue[] = [];
      const voiceHost: VoiceHost = {
        status: async () => ({ id: "voice-1", status: "listening" }),
        components: async () => ({ components: [] }),
        start: async () => ({ id: "voice-1", status: "listening" }),
        stop: async () => ({ id: "voice-1", status: "idle" }),
        interrupt: async () => ({ id: "voice-1", status: "interrupted" }),
        injectTranscript: async () => ({ id: "turn-1" }),
        speak: async (params) => {
          spoken.push(params ?? null);
          return { id: "turn-1", status: "completed" };
        },
        transcribeAudio: async () => ({ id: "turn-1", status: "asr_final" }),
        synthesizeSpeech: async (params) => {
          synthesized.push(params ?? null);
          return {
            audioBase64: "AAAA",
            mimeType: "audio/wav",
            byteLength: 3,
          };
        },
        latency: async () => ({ totalToPlaybackMs: 50 }),
        recentTurns: async () => ({ turns: [] }),
      };
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
        voiceHost,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "host-request",
        requestId: 16,
        method: "voice-speak",
        params: { text: "hello" },
      });
      worker.emit({
        type: "host-request",
        requestId: 17,
        method: "voice-synthesize-speech",
        params: { text: "hello" },
      });

      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const response = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 16,
            );
            const synthResponse = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 17,
            );
            expect(spoken).toEqual([{ text: "hello" }]);
            expect(synthesized).toEqual([{ text: "hello" }]);
            expect(response).toMatchObject({
              type: "host-response",
              requestId: 16,
              success: true,
              payload: { id: "turn-1", status: "completed" },
            });
            expect(synthResponse).toMatchObject({
              type: "host-response",
              requestId: 17,
              success: true,
              payload: { audioBase64: "AAAA", mimeType: "audio/wav" },
            });
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 10);
      });
    }));

  it("seeds and replaces the remote plugin auth token on demand", () =>
    withTempDir((dir) => {
      const previousToken = process.env.ELIZA_API_TOKEN;
      process.env.ELIZA_API_TOKEN = "remote-plugin-test-token";
      const worker = new FakeWorkerHandle();
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "host-request",
        requestId: 11,
        method: "get-auth-token",
      });
      worker.emit({
        type: "host-request",
        requestId: 12,
        method: "set-auth-token",
        params: { token: "rotated-token" },
      });
      worker.emit({
        type: "host-request",
        requestId: 13,
        method: "get-auth-token",
      });

      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const initial = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 11,
            );
            expect(initial).toMatchObject({
              success: true,
              payload: { token: "remote-plugin-test-token" },
            });
            const setResp = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 12,
            );
            expect(setResp).toMatchObject({
              success: true,
              payload: { ok: true },
            });
            const rotated = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 13,
            );
            expect(rotated).toMatchObject({
              success: true,
              payload: { token: "rotated-token" },
            });
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            if (previousToken === undefined) {
              delete process.env.ELIZA_API_TOKEN;
            } else {
              process.env.ELIZA_API_TOKEN = previousToken;
            }
          }
        }, 10);
      });
    }));

  it("returns an error response for unknown host-request methods", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "host-request",
        requestId: 42,
        // Force an unknown method through the dispatcher to assert the
        // error-response path. Casting through unknown is necessary
        // because the type union only allows known methods.
        method: "totally-made-up" as unknown as "list-remote-plugins",
      });

      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const response = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 42,
            );
            expect(response).toMatchObject({
              type: "host-response",
              requestId: 42,
              success: false,
            });
            expect((response as { error?: string }).error).toContain(
              "totally-made-up",
            );
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 10);
      });
    }));

  it("denies start-remote-plugin when caller lacks host:manage-remote-plugins", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({
        sourceDir: writePayload(dir, { manageRemotePlugins: false }),
      });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "host-request",
        requestId: 50,
        method: "start-remote-plugin",
        params: { id: "bunny.search" },
      });

      return new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const response = worker.messages.find(
              (m) => m.type === "host-response" && m.requestId === 50,
            );
            expect(response).toMatchObject({
              type: "host-response",
              requestId: 50,
              success: false,
            });
            expect((response as { error?: string }).error).toContain(
              "manage-remote-plugins",
            );
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 10);
      });
    }));

  it("routes invoke-remote-plugin request from A to B and returns the payload", () =>
    withTempDir((dir) => {
      const workerA = new FakeWorkerHandle();
      const workerB = new FakeWorkerHandle();
      let nextWorker: FakeWorkerHandle = workerA;
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => nextWorker },
        now: () => 1700000000000,
      });

      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      const secondDir = join(dir, "second");
      mkdirSync(join(secondDir, "views"), { recursive: true });
      writeFileSync(
        join(secondDir, "plugin.json"),
        JSON.stringify({
          id: "bunny.calc",
          name: "Calc",
          version: "1.0.0",
          description: "Calculator",
          mode: "background",
          permissions: { host: {}, bun: {} },
          view: {
            relativePath: "views/index.html",
            title: "Calc",
            width: 240,
            height: 160,
          },
          worker: { relativePath: "worker.ts" },
        }),
        "utf8",
      );
      writeFileSync(
        join(secondDir, "worker.ts"),
        "postMessage({type:'ready'});",
      );
      writeFileSync(join(secondDir, "views", "index.html"), "<div>Calc</div>");
      nextWorker = workerB;
      manager.installFromDirectory({ sourceDir: secondDir });
      manager.startWorker("bunny.calc");

      workerA.emit({
        type: "host-request",
        requestId: 99,
        method: "invoke-remote-plugin",
        params: {
          remotePluginId: "bunny.calc",
          method: "add",
          params: { a: 2, b: 3 },
        },
      });

      const forwarded = workerB.messages.find((m) => m.type === "request");
      expect(forwarded).toMatchObject({
        type: "request",
        method: "add",
        params: { a: 2, b: 3 },
      });
      const forwardedId = (forwarded as { requestId: number }).requestId;

      workerB.emit({
        type: "response",
        requestId: forwardedId,
        success: true,
        payload: { sum: 5 },
      });

      const aResponse = workerA.messages.find(
        (m) => m.type === "host-response" && m.requestId === 99,
      );
      expect(aResponse).toMatchObject({
        type: "host-response",
        requestId: 99,
        success: true,
        payload: { sum: 5 },
      });
    }));

  it("invokes a running worker directly from the host", async () =>
    withTempDir(async (dir) => {
      const worker = new FakeWorkerHandle();
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      const resultPromise = manager.invokeWorker({
        id: "bunny.search",
        method: "lookup",
        params: { query: "eliza" },
      });
      const forwarded = worker.messages.find((m) => m.type === "request");
      expect(forwarded).toMatchObject({
        type: "request",
        method: "lookup",
        params: { query: "eliza" },
      });

      worker.emit({
        type: "response",
        requestId: (forwarded as { requestId: number }).requestId,
        success: true,
        payload: { ok: true },
      });

      await expect(resultPromise).resolves.toEqual({ ok: true });
    }));

  it("tails worker events with sequence cursors and bounded limits", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      let tick = 0;
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000 + tick++,
        maxWorkerEvents: 500,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      worker.emit({
        type: "event",
        name: "first",
        payload: { count: 1 },
      });
      worker.emit({
        type: "event",
        name: "second",
        payload: { count: 2 },
      });

      const initial = manager.tailWorkerEvents({ id: "bunny.search" });
      expect(initial).toMatchObject({
        id: "bunny.search",
        nextSequence: 2,
        minimumSequence: 1,
        gapBeforeSequence: null,
        events: [
          {
            remotePluginId: "bunny.search",
            remotePluginId: "bunny.search",
            sequence: 1,
            name: "first",
            payload: { count: 1 },
          },
          {
            sequence: 2,
            name: "second",
            payload: { count: 2 },
          },
        ],
      });

      worker.emit({
        type: "event",
        name: "third",
        payload: { count: 3 },
      });
      expect(
        manager.tailWorkerEvents({
          id: "bunny.search",
          afterSequence: initial.nextSequence,
        }).events,
      ).toMatchObject([
        {
          sequence: 3,
          name: "third",
          payload: { count: 3 },
        },
      ]);

      for (let index = 0; index < 510; index += 1) {
        worker.emit({
          type: "event",
          name: "many",
          payload: { index },
        });
      }
      const capped = manager.tailWorkerEvents({
        id: "bunny.search",
        afterSequence: 0,
        limit: 1_000,
      });
      expect(capped.events).toHaveLength(500);
      expect(capped.minimumSequence).toBe(14);
      expect(capped.gapBeforeSequence).toBe(14);
      expect(capped.nextSequence).toBe(513);
    }));

  it("rejects event tailing when the worker is not running", () =>
    withTempDir((dir) => {
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });

      expect(() => manager.tailWorkerEvents({ id: "bunny.search" })).toThrow(
        "not running",
      );
    }));

  it("invoke-remote-plugin returns error when target is not running", () =>
    withTempDir((dir) => {
      const workerA = new FakeWorkerHandle();
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => workerA },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      workerA.emit({
        type: "host-request",
        requestId: 7,
        method: "invoke-remote-plugin",
        params: { remotePluginId: "does-not-exist", method: "noop" },
      });

      const response = workerA.messages.find(
        (m) => m.type === "host-response" && m.requestId === 7,
      );
      expect(response).toMatchObject({
        type: "host-response",
        requestId: 7,
        success: false,
      });
      expect((response as { error?: string }).error).toContain(
        "does-not-exist",
      );
    }));

  it("invoke-remote-plugin fails caller when target stops mid-flight", () =>
    withTempDir((dir) => {
      const workerA = new FakeWorkerHandle();
      const workerB = new FakeWorkerHandle();
      let nextWorker: FakeWorkerHandle = workerA;
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => nextWorker },
        now: () => 1700000000000,
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      const secondDir = join(dir, "second");
      mkdirSync(join(secondDir, "views"), { recursive: true });
      writeFileSync(
        join(secondDir, "plugin.json"),
        JSON.stringify({
          id: "bunny.calc",
          name: "Calc",
          version: "1.0.0",
          description: "Calculator",
          mode: "background",
          permissions: { host: {}, bun: {} },
          view: {
            relativePath: "views/index.html",
            title: "Calc",
            width: 240,
            height: 160,
          },
          worker: { relativePath: "worker.ts" },
        }),
        "utf8",
      );
      writeFileSync(
        join(secondDir, "worker.ts"),
        "postMessage({type:'ready'});",
      );
      writeFileSync(join(secondDir, "views", "index.html"), "<div>Calc</div>");
      nextWorker = workerB;
      manager.installFromDirectory({ sourceDir: secondDir });
      manager.startWorker("bunny.calc");

      workerA.emit({
        type: "host-request",
        requestId: 11,
        method: "invoke-remote-plugin",
        params: { remotePluginId: "bunny.calc", method: "slow" },
      });

      manager.stopWorker("bunny.calc");

      const aResponse = workerA.messages.find(
        (m) => m.type === "host-response" && m.requestId === 11,
      );
      expect(aResponse).toMatchObject({
        type: "host-response",
        requestId: 11,
        success: false,
      });
      expect((aResponse as { error?: string }).error).toContain("stopped");
    }));

  it("routes emit-remote-plugin-event between two running remote plugins", () =>
    withTempDir((dir) => {
      const workerA = new FakeWorkerHandle();
      const workerB = new FakeWorkerHandle();
      let nextWorker: FakeWorkerHandle = workerA;
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => nextWorker },
        now: () => 1700000000000,
      });

      // Install bunny.search (worker A)
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");

      // Install a second remote plugin (worker B) with a different id
      const secondDir = join(dir, "second");
      mkdirSync(join(secondDir, "views"), { recursive: true });
      writeFileSync(
        join(secondDir, "plugin.json"),
        JSON.stringify({
          id: "bunny.timer",
          name: "Timer",
          version: "1.0.0",
          description: "Timer helper",
          mode: "background",
          permissions: { host: {}, bun: {} },
          view: {
            relativePath: "views/index.html",
            title: "Timer",
            width: 240,
            height: 160,
          },
          worker: { relativePath: "worker.ts" },
        }),
        "utf8",
      );
      writeFileSync(
        join(secondDir, "worker.ts"),
        "postMessage({type:'ready'});",
      );
      writeFileSync(join(secondDir, "views", "index.html"), "<div>Timer</div>");
      nextWorker = workerB;
      manager.installFromDirectory({ sourceDir: secondDir });
      manager.startWorker("bunny.timer");

      // A emits to B
      workerA.emit({
        type: "action",
        action: "emit-remote-plugin-event",
        payload: {
          remotePluginId: "bunny.timer",
          name: "ping",
          payload: { count: 1 },
        },
      });

      const eventMsg = workerB.messages.find((m) => m.type === "event");
      expect(eventMsg).toMatchObject({
        type: "event",
        name: "ping",
        payload: { count: 1 },
      });

      // Emit to a non-running remote plugin — should be dropped silently (warning only)
      workerA.emit({
        type: "action",
        action: "emit-remote-plugin-event",
        payload: {
          remotePluginId: "does-not-exist",
          name: "ghost",
        },
      });
      // workerB should NOT have received anything new
      const eventsAfter = workerB.messages.filter((m) => m.type === "event");
      expect(eventsAfter).toHaveLength(1);
    }));

  it("ignores late worker events after stop", () =>
    withTempDir((dir) => {
      const worker = new FakeWorkerHandle();
      const workerEvents: string[] = [];
      const manager = new RemotePluginHost({
        storeRoot: join(dir, "store"),
        workerRunner: { start: () => worker },
        now: () => 1700000000000 + workerEvents.length,
        events: {
          workerChanged: (status) => {
            workerEvents.push(`${status.id}:${status.state}`);
          },
        },
      });
      manager.installFromDirectory({ sourceDir: writePayload(dir) });
      manager.startWorker("bunny.search");
      manager.stopWorker("bunny.search");

      worker.emit({ type: "ready" });
      worker.fail("late boom");

      expect(manager.getWorkerStatus("bunny.search")).toMatchObject({
        id: "bunny.search",
        state: "stopped",
        error: null,
      });
      expect(workerEvents).toEqual([
        "bunny.search:starting",
        "bunny.search:running",
        "bunny.search:stopped",
      ]);
    }));
});
