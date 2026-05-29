import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";
import type { SessionInfo } from "../../src/services/types.js";

function runtime(settings: Record<string, string | undefined> = {}) {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((key: string) => settings[key]),
    services: new Map<string, unknown[]>(),
  } as never;
}

type Store = {
  create: (s: SessionInfo) => Promise<void>;
  get: (id: string) => Promise<SessionInfo | undefined>;
  update: (id: string, patch: Partial<SessionInfo>) => Promise<void>;
};

function getStore(service: AcpService): Store {
  return Reflect.get(service, "store") as Store;
}

function baseSession(over: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date();
  return {
    id: "sess-1",
    name: "sess-1",
    agentType: "codex",
    workdir: "/tmp/wd",
    status: "ready",
    approvalPreset: "auto",
    createdAt: now,
    lastActivityAt: now,
    metadata: { label: "demo" },
    acpxSessionId: "acpx-1",
    ...over,
  };
}

describe("AcpService.updateSessionMetadata", () => {
  it("merges patch into existing metadata without replacing", async () => {
    const service = new AcpService(runtime());
    const store = getStore(service);
    await store.create(
      baseSession({ metadata: { label: "demo", roomId: "room-A" } }),
    );

    await service.updateSessionMetadata("sess-1", {
      threadRoomId: "thread-B",
    });

    const after = await store.get("sess-1");
    expect(after?.metadata).toEqual({
      label: "demo",
      roomId: "room-A",
      threadRoomId: "thread-B",
    });
  });

  it("overwrites an existing key with the patch value", async () => {
    const service = new AcpService(runtime());
    const store = getStore(service);
    await store.create(
      baseSession({ metadata: { label: "demo", threadRoomId: "old" } }),
    );

    await service.updateSessionMetadata("sess-1", { threadRoomId: "new" });

    const after = await store.get("sess-1");
    expect(after?.metadata?.threadRoomId).toBe("new");
  });

  it("is a no-op when the session does not exist", async () => {
    const service = new AcpService(runtime());
    await expect(
      service.updateSessionMetadata("missing", { x: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("AcpService.findResumableSessionByLabel", () => {
  async function withSessionState(
    fn: (acpxStateRoot: string) => Promise<void>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "acpx-test-"));
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await fn(root);
  }

  async function writeStateFile(root: string, acpxSessionId: string) {
    // The resume probe reads the real `<acpxSessionId>.json` artifact (the
    // never-written `.stream.ndjson` was the state-lost false-positive bug).
    await writeFile(join(root, "sessions", `${acpxSessionId}.json`), "{}");
  }

  function pointStateRootAt(service: AcpService, root: string) {
    Object.defineProperty(service, "acpxStateRoot", {
      value: () => root,
      writable: true,
      configurable: true,
    });
  }

  it("returns the session when label, workdir, state file and disk match", async () => {
    await withSessionState(async (root) => {
      const wd = await mkdtemp(join(tmpdir(), "wd-"));
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const store = getStore(service);
      await writeStateFile(root, "acpx-1");
      await store.create(
        baseSession({
          workdir: wd,
          metadata: { label: "demo" },
          acpxSessionId: "acpx-1",
        }),
      );

      const found = await service.findResumableSessionByLabel("demo", wd);
      expect(found?.id).toBe("sess-1");
    });
  });

  it("ignores sessions whose status is busy/errored/cancelled", async () => {
    await withSessionState(async (root) => {
      const wd = await mkdtemp(join(tmpdir(), "wd-"));
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const store = getStore(service);
      await writeStateFile(root, "acpx-busy");
      await store.create(
        baseSession({
          id: "sess-busy",
          workdir: wd,
          status: "busy",
          acpxSessionId: "acpx-busy",
        }),
      );

      const found = await service.findResumableSessionByLabel("demo", wd);
      expect(found).toBeUndefined();
    });
  });

  it("ignores sessions whose workdir differs", async () => {
    await withSessionState(async (root) => {
      const wd = await mkdtemp(join(tmpdir(), "wd-"));
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const store = getStore(service);
      await writeStateFile(root, "acpx-1");
      await store.create(
        baseSession({
          workdir: "/some/other/dir",
          acpxSessionId: "acpx-1",
        }),
      );

      const found = await service.findResumableSessionByLabel("demo", wd);
      expect(found).toBeUndefined();
    });
  });

  it("ignores sessions whose acpx state file is missing", async () => {
    await withSessionState(async (root) => {
      const wd = await mkdtemp(join(tmpdir(), "wd-"));
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const store = getStore(service);
      await store.create(
        baseSession({ workdir: wd, acpxSessionId: "acpx-missing" }),
      );

      const found = await service.findResumableSessionByLabel("demo", wd);
      expect(found).toBeUndefined();
    });
  });

  it("prefers the most recently active session when several match", async () => {
    await withSessionState(async (root) => {
      const wd = await mkdtemp(join(tmpdir(), "wd-"));
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const store = getStore(service);
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();
      await writeStateFile(root, "acpx-old");
      await writeStateFile(root, "acpx-new");
      await store.create(
        baseSession({
          id: "sess-old",
          workdir: wd,
          acpxSessionId: "acpx-old",
          lastActivityAt: older,
        }),
      );
      await store.create(
        baseSession({
          id: "sess-new",
          workdir: wd,
          acpxSessionId: "acpx-new",
          lastActivityAt: newer,
        }),
      );

      const found = await service.findResumableSessionByLabel("demo", wd);
      expect(found?.id).toBe("sess-new");
    });
  });
});

describe("AcpService.resumeOrphanedBusySessions", () => {
  async function withSessionState(
    fn: (acpxStateRoot: string) => Promise<void>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "acpx-test-"));
    await mkdir(join(root, "sessions"), { recursive: true });
    await fn(root);
  }
  async function writeStateFile(root: string, acpxSessionId: string) {
    // The resume probe reads the real `<acpxSessionId>.json` artifact (the
    // never-written `.stream.ndjson` was the state-lost false-positive bug).
    await writeFile(join(root, "sessions", `${acpxSessionId}.json`), "{}");
  }
  function pointStateRootAt(service: AcpService, root: string) {
    Object.defineProperty(service, "acpxStateRoot", {
      value: () => root,
      writable: true,
      configurable: true,
    });
  }
  function stubSendPrompt(service: AcpService) {
    const calls: Array<{ sessionId: string; text: string }> = [];
    const stub = vi.fn(async (sessionId: string, text: string) => {
      calls.push({ sessionId, text });
      return {
        sessionId,
        response: "",
        finalText: "",
        stopReason: "end_turn" as const,
        durationMs: 0,
        exitCode: 0,
      };
    });
    Object.defineProperty(service, "sendPrompt", {
      value: stub,
      writable: true,
      configurable: true,
    });
    return calls;
  }

  it("resumes sessions in busy/tool_running/running with intact state", async () => {
    await withSessionState(async (root) => {
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const calls = stubSendPrompt(service);
      const store = getStore(service);
      await writeStateFile(root, "acpx-busy");
      await writeStateFile(root, "acpx-tool");
      await writeStateFile(root, "acpx-run");
      await store.create(
        baseSession({
          id: "s-busy",
          status: "busy",
          acpxSessionId: "acpx-busy",
        }),
      );
      await store.create(
        baseSession({
          id: "s-tool",
          status: "tool_running",
          acpxSessionId: "acpx-tool",
        }),
      );
      await store.create(
        baseSession({
          id: "s-run",
          status: "running",
          acpxSessionId: "acpx-run",
        }),
      );

      const result = await service.resumeOrphanedBusySessions();
      expect(result.resumed).toBe(3);
      expect(result.skipped).toBe(0);
      expect(calls.map((c) => c.sessionId).sort()).toEqual([
        "s-busy",
        "s-run",
        "s-tool",
      ]);
      expect(calls[0]?.text).toMatch(/previous turn was interrupted/);
    });
  });

  it("skips idle sessions (ready/blocked/authenticating)", async () => {
    await withSessionState(async (root) => {
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const calls = stubSendPrompt(service);
      const store = getStore(service);
      await writeStateFile(root, "acpx-ready");
      await writeStateFile(root, "acpx-blocked");
      await writeStateFile(root, "acpx-auth");
      await store.create(
        baseSession({
          id: "s-ready",
          status: "ready",
          acpxSessionId: "acpx-ready",
        }),
      );
      await store.create(
        baseSession({
          id: "s-blocked",
          status: "blocked",
          acpxSessionId: "acpx-blocked",
        }),
      );
      await store.create(
        baseSession({
          id: "s-auth",
          status: "authenticating",
          acpxSessionId: "acpx-auth",
        }),
      );

      const result = await service.resumeOrphanedBusySessions();
      expect(result.resumed).toBe(0);
      expect(calls).toHaveLength(0);
    });
  });

  it("skips terminal sessions (stopped/errored/cancelled/completed)", async () => {
    await withSessionState(async (root) => {
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const calls = stubSendPrompt(service);
      const store = getStore(service);
      await writeStateFile(root, "acpx-stopped");
      await writeStateFile(root, "acpx-errored");
      await store.create(
        baseSession({
          id: "s-stopped",
          status: "stopped",
          acpxSessionId: "acpx-stopped",
        }),
      );
      await store.create(
        baseSession({
          id: "s-errored",
          status: "errored",
          acpxSessionId: "acpx-errored",
        }),
      );

      const result = await service.resumeOrphanedBusySessions();
      expect(result.resumed).toBe(0);
      expect(calls).toHaveLength(0);
    });
  });

  it("skips busy sessions missing acpxSessionId", async () => {
    await withSessionState(async (root) => {
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const calls = stubSendPrompt(service);
      const store = getStore(service);
      const noAcpxId = baseSession({
        id: "s-no-acpx",
        status: "busy",
      });
      delete (noAcpxId as Partial<SessionInfo>).acpxSessionId;
      await store.create(noAcpxId);

      const result = await service.resumeOrphanedBusySessions();
      expect(result.resumed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(calls).toHaveLength(0);
    });
  });

  it("skips busy sessions whose acpx state file is missing", async () => {
    await withSessionState(async (root) => {
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      const calls = stubSendPrompt(service);
      const store = getStore(service);
      await store.create(
        baseSession({
          id: "s-no-state",
          status: "busy",
          acpxSessionId: "acpx-missing",
        }),
      );

      const result = await service.resumeOrphanedBusySessions();
      expect(result.resumed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(calls).toHaveLength(0);
    });
  });

  it("returns zeros when there are no sessions at all", async () => {
    await withSessionState(async (root) => {
      const service = new AcpService(runtime());
      pointStateRootAt(service, root);
      stubSendPrompt(service);

      const result = await service.resumeOrphanedBusySessions();
      expect(result).toEqual({ resumed: 0, skipped: 0 });
    });
  });
});
