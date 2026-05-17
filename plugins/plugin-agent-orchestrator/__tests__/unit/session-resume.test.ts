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
    await writeFile(
      join(root, "sessions", `${acpxSessionId}.stream.ndjson`),
      "",
    );
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
