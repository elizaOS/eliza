import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SystemdLogindSessionResolver } from "./linux-logind";
import { createDiskConfirmationToken, createInstallPlan } from "./planner";
import { createTestDiskInventory } from "./test-inventory";
import {
  createUnixInstallServer,
  LinuxLogindActiveOwnerSessionProvider,
} from "./unix-transport";

function fixture() {
  const session = {
    ownerId: "owner",
    uid: 1000,
    sessionId: "session",
    active: true,
    locked: false,
  };
  const handle = { pid: 123, isAlive: vi.fn(async () => true), close: vi.fn() };
  const logind = { inspectForProcess: vi.fn(async () => session) };
  const provider = new LinuxLogindActiveOwnerSessionProvider(logind);
  const identity = provider.bindPeer({ uid: 1000, gid: 1000, process: handle });
  return { session, handle, logind, provider, identity };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function requestFrame() {
  const target = createTestDiskInventory();
  const request = {
    mode: "erase-disk" as const,
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
  };
  const plan = createInstallPlan(request, target);
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      operation: "execute-reviewed-plan",
      request,
      plan,
      authorization: {
        planId: plan.planId,
        inventoryFingerprint: "fixture",
        ownerId: "owner",
        issuedAt: "fixture",
        expiresAt: "fixture",
        nonce: "fixture",
        credential: "fixture",
      },
    }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

describe("installer service shutdown", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "drains disconnected=%s work with cleanup failure=%s",
    async (disconnectFirst, cleanupFails) => {
      const f = fixture();
      const directory = await mkdtemp(join(tmpdir(), "installer-shutdown-"));
      const path = join(directory, "service.sock");
      const entered = deferred<AbortSignal>();
      const release = deferred<void>();
      let accepted: Socket | undefined;
      if (cleanupFails)
        f.handle.close.mockImplementation(() => {
          throw new Error("pidfd close failed");
        });
      const server = createUnixInstallServer({
        activeOwner: f.provider,
        peerCredentials: {
          inspect: (socket) => {
            accepted = socket;
            return { uid: 1000, gid: 1000, process: f.handle };
          },
        },
        service: {
          abortSemantics: "confirmed-stop-or-lock-retained",
          execute: async (_input, _peer, signal) => {
            entered.resolve(signal);
            await release.promise;
            signal.throwIfAborted();
            throw new Error("shutdown did not cancel execution");
          },
        },
      });
      let client: Socket | undefined;
      try {
        server.listen(path);
        await once(server, "listening");
        client = connect(path);
        client.on("error", () => {});
        await once(client, "connect");
        client.end(requestFrame());
        const signal = await entered.promise;
        if (!accepted) throw new Error("missing accepted socket");
        if (disconnectFirst) {
          const disconnected = once(accepted, "close");
          accepted.destroy();
          await disconnected;
        }
        const shutdown = server.shutdown();
        expect(server.shutdown()).toBe(shutdown);
        let settled = false;
        const observed = shutdown.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(signal.aborted).toBe(true);
        expect(server.listening).toBe(false);
        expect(settled).toBe(false);
        expect(f.handle.close).not.toHaveBeenCalled();
        release.resolve();
        if (cleanupFails)
          await expect(shutdown).rejects.toMatchObject({
            name: "InstallServiceError",
            message: "Installer shutdown cleanup failed.",
          });
        else await shutdown;
        await observed;
        expect(f.handle.close).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        client?.destroy();
        await server.shutdown().catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("cancels an incomplete frame without admitting an execution", async () => {
    const f = fixture();
    const inspected = deferred<void>();
    const directory = await mkdtemp(
      join(tmpdir(), "installer-shutdown-frame-"),
    );
    const path = join(directory, "service.sock");
    const execute = vi.fn();
    const server = createUnixInstallServer({
      activeOwner: f.provider,
      peerCredentials: {
        inspect: () => {
          inspected.resolve();
          return { uid: 1000, gid: 1000, process: f.handle };
        },
      },
      service: { abortSemantics: "confirmed-stop-or-lock-retained", execute },
    });
    let client: Socket | undefined;
    try {
      server.listen(path);
      await once(server, "listening");
      client = connect(path);
      client.on("error", () => {});
      await once(client, "connect");
      client.write(requestFrame().subarray(0, 7));
      await inspected.promise;
      await server.shutdown();
      expect(execute).not.toHaveBeenCalled();
      expect(f.handle.close).toHaveBeenCalledTimes(1);
    } finally {
      client?.destroy();
      await server.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("kernel-bound owner lookup", () => {
  it.each([false, true])(
    "reports peer cleanup failure after service failure=%s",
    async (serviceFails) => {
      const f = fixture();
      const directory = await mkdtemp(join(tmpdir(), "installer-cleanup-"));
      const path = join(directory, "service.sock");
      f.handle.close.mockImplementation(() => {
        throw new Error("pidfd close failed");
      });
      const server = createUnixInstallServer({
        activeOwner: f.provider,
        peerCredentials: {
          inspect: () => ({ uid: 1000, gid: 1000, process: f.handle }),
        },
        service: {
          abortSemantics: "confirmed-stop-or-lock-retained",
          execute: async () => {
            if (serviceFails) throw new Error("execution failed");
            return {
              planId: "fixture",
              completedActions: 1,
              finalInventoryFingerprint: "fixture",
            };
          },
        },
      });
      let client: Socket | undefined;
      try {
        server.listen(path);
        await once(server, "listening");
        client = connect(path);
        const chunks: Buffer[] = [];
        client.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        await once(client, "connect");
        const ended = once(client, "end");
        client.end(requestFrame());
        await ended;
        const bytes = Buffer.concat(chunks);
        expect(bytes.readUInt32BE(0)).toBe(bytes.length - 4);
        const response = JSON.parse(bytes.subarray(4).toString("utf8"));
        expect(response.ok).toBe(false);
        expect(response.error).toContain("pidfd close failed");
        if (serviceFails) expect(response.error).toContain("execution failed");
        expect(f.handle.close).toHaveBeenCalledTimes(1);
      } finally {
        client?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("handles socket errors after framing and retains the peer until cancellation settles", async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "installer-transport-"));
    const path = join(directory, "service.sock");
    const entered = deferred<AbortSignal>();
    const release = deferred<void>();
    const closed = deferred<void>();
    f.handle.close.mockImplementation(() => closed.resolve());
    let accepted: Socket | undefined;
    const server = createUnixInstallServer({
      activeOwner: f.provider,
      peerCredentials: {
        inspect: (socket) => {
          accepted = socket;
          return { uid: 1000, gid: 1000, process: f.handle };
        },
      },
      service: {
        abortSemantics: "confirmed-stop-or-lock-retained",
        execute: async (_input, _peer, signal) => {
          if (!signal) throw new Error("missing cancellation signal");
          entered.resolve(signal);
          await release.promise;
          throw signal.reason;
        },
      },
    });
    let client: Socket | undefined;
    try {
      server.listen(path);
      await once(server, "listening");
      client = connect(path);
      client.on("error", () => {});
      await once(client, "connect");
      client.end(requestFrame());
      const signal = await entered.promise;
      const error = new Error("connection reset after request framing");
      if (!accepted) throw new Error("missing accepted socket");
      const disconnected = once(accepted, "close").catch(() => {});
      accepted.destroy(error);
      await disconnected;
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(error);
      expect(f.handle.close).not.toHaveBeenCalled();
      release.resolve();
      await closed.promise;
      expect(f.handle.close).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      client?.destroy();
      accepted?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("preserves busctl failure through the production resolver and owner adapter", async () => {
    const f = fixture();
    const error = new Error("busctl failed to connect to system bus");
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: () => "owner",
      runner: {
        run: async () => {
          throw error;
        },
      },
    });
    const provider = new LinuxLogindActiveOwnerSessionProvider(resolver);
    const identity = provider.bindPeer({
      uid: 1000,
      gid: 1000,
      process: f.handle,
    });
    await expect(provider.inspectForProcess(identity)).rejects.toBe(error);
  });
  it("preserves logind and liveness failures", async () => {
    const f = fixture();
    const error = new Error("session lookup unavailable");
    f.logind.inspectForProcess.mockRejectedValueOnce(error);
    await expect(f.provider.inspectForProcess(f.identity)).rejects.toBe(error);
    f.handle.isAlive.mockRejectedValueOnce(error);
    await expect(f.provider.inspectForProcess(f.identity)).rejects.toBe(error);
  });

  it("refuses a process that exits during the logind lookup", async () => {
    const f = fixture();
    f.handle.isAlive.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.provider.inspectForProcess(f.identity)).resolves.toBeNull();
    expect(f.logind.inspectForProcess).toHaveBeenCalledWith(f.handle, 1000);
  });

  it("returns the session only for a bound process still alive after lookup", async () => {
    const f = fixture();
    await expect(
      f.provider.inspectForProcess({ pid: 123, livenessToken: {} }),
    ).resolves.toBeNull();
    expect(f.logind.inspectForProcess).not.toHaveBeenCalled();
    await expect(f.provider.inspectForProcess(f.identity)).resolves.toEqual(
      f.session,
    );
    expect(f.handle.isAlive).toHaveBeenCalledTimes(2);
  });
});
