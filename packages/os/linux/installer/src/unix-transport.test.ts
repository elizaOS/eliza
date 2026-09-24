import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalInstallPeerCredentials } from "./root-service";
import {
  createUnixInstallServer,
  InstallerRequestGate,
  type KernelBoundPeerProcessHandle,
  LinuxLogindActiveOwnerSessionProvider,
  listenUnixInstallServer,
  parseUnixInstallWireFrame,
  rejectOverloadedUnixSocket,
  type UnixInstallService,
} from "./unix-transport";

const servers: import("node:net").Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function requestBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      operation: "execute-reviewed-plan",
      request: {
        mode: "erase-disk",
        targetStableId: "disk",
        expectedSizeBytes: 1,
        confirmationToken: "token",
      },
      plan: {
        schemaVersion: 1,
        planId: "plan",
        mode: "erase-disk",
        target: {},
        preservedPartitionIds: [],
        partitions: [],
        actions: [],
        warnings: [],
        compatibility: {},
        executable: false,
      },
      authorization: {
        planId: "plan",
        inventoryFingerprint: "inventory",
        ownerId: "owner",
        issuedAt: "2026-08-25T00:00:00.000Z",
        expiresAt: "2026-08-25T00:01:00.000Z",
        nonce: "nonce",
        credential: "credential",
      },
    }),
  );
}

function frame(body: Buffer, trailing = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body, trailing]);
}

async function exchange(socketPath: string, bytes: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.end(bytes));
    socket.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    socket.on("error", reject);
    socket.on("end", () => {
      const output = Buffer.concat(chunks);
      if (output.length < 4) {
        reject(new Error("Installer connection closed without a response."));
        return;
      }
      const length = output.readUInt32BE(0);
      resolve(JSON.parse(output.subarray(4, 4 + length).toString("utf8")));
    });
  });
}

async function fixture(
  options: {
    frameTimeoutMilliseconds?: number;
    executionTimeoutMilliseconds?: number;
    execute?: (
      peer: LocalInstallPeerCredentials,
      signal: AbortSignal,
    ) => Promise<{
      planId: string;
      completedActions: number;
      finalInventoryFingerprint: string;
    }>;
  } = {},
) {
  const socketPath = `\0elizaos-installer-${process.pid}-${Math.random()}`;
  const processHandle: KernelBoundPeerProcessHandle = {
    pid: 4321,
    isAlive: async () => true,
    close: () => undefined,
  };
  const activeOwner = new LinuxLogindActiveOwnerSessionProvider({
    inspectForProcess: async (process, uid) => ({
      ownerId: "owner",
      uid,
      sessionId: `session-${process.pid}`,
      active: true,
      locked: false,
    }),
  });
  let receivedPeer: LocalInstallPeerCredentials | undefined;
  let executions = 0;
  const server = createUnixInstallServer({
    frameTimeoutMilliseconds: options.frameTimeoutMilliseconds,
    executionTimeoutMilliseconds: options.executionTimeoutMilliseconds,
    activeOwner,
    peerCredentials: {
      inspect: () => ({ uid: 1000, gid: 1000, process: processHandle }),
    },
    service: {
      abortSemantics: "confirmed-stop-or-lock-retained",
      execute: async (_input, peer, _signal) => {
        executions += 1;
        receivedPeer = peer;
        if (options.execute) {
          return options.execute(peer, _signal);
        }
        return {
          planId: "plan",
          completedActions: 0,
          finalInventoryFingerprint: "inventory",
        };
      },
    },
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    server,
    getPeer: () => receivedPeer,
    getExecutions: () => executions,
  };
}

describe("Unix installer transport", () => {
  it("rejects trailing bytes at the wire framing boundary", () => {
    expect(() =>
      parseUnixInstallWireFrame(frame(requestBytes(), Buffer.from("x"))),
    ).toThrow("trailing");
  });

  it("refuses a listener not inherited as the single named systemd socket", async () => {
    const server = createUnixInstallServer({
      activeOwner: new LinuxLogindActiveOwnerSessionProvider({
        inspectForProcess: async () => null,
      }),
      peerCredentials: {
        inspect: () => ({
          uid: 1,
          gid: 1,
          process: {
            pid: 1,
            isAlive: async () => true,
            close: () => undefined,
          },
        }),
      },
      service: {
        abortSemantics: "confirmed-stop-or-lock-retained",
        execute: async () => Promise.reject(new Error("unreachable")),
      },
    });
    await expect(
      listenUnixInstallServer(
        server,
        "/run/elizaos-installer/service.sock",
        {},
      ),
    ).rejects.toThrow("systemd AF_UNIX listener");
  });

  it("requires the activated descriptor name to be exactly installer", async () => {
    const server = createUnixInstallServer({
      activeOwner: new LinuxLogindActiveOwnerSessionProvider({
        inspectForProcess: async () => null,
      }),
      peerCredentials: {
        inspect: () => ({
          uid: 1,
          gid: 1,
          process: {
            pid: 1,
            isAlive: async () => true,
            close: () => undefined,
          },
        }),
      },
      service: {
        abortSemantics: "confirmed-stop-or-lock-retained",
        execute: async () => Promise.reject(new Error("unreachable")),
      },
    });
    await expect(
      listenUnixInstallServer(server, "/run/elizaos-installer/service.sock", {
        LISTEN_PID: String(process.pid),
        LISTEN_FDS: "1",
      }),
    ).rejects.toThrow("named systemd AF_UNIX listener");
  });

  it("enforces the configured concurrent connection ceiling", () => {
    const server = createUnixInstallServer({
      maxConnections: 3,
      activeOwner: new LinuxLogindActiveOwnerSessionProvider({
        inspectForProcess: async () => null,
      }),
      peerCredentials: {
        inspect: () => ({
          uid: 1,
          gid: 1,
          process: {
            pid: 1,
            isAlive: async () => true,
            close: () => undefined,
          },
        }),
      },
      service: {
        abortSemantics: "confirmed-stop-or-lock-retained",
        execute: async () => Promise.reject(new Error("unreachable")),
      },
    });
    expect(server.maxConnections).toBe(3);
  });

  it.each([999, 86_400_001])(
    "rejects out-of-range execution timeout %i",
    (executionTimeoutMilliseconds) => {
      expect(() =>
        createUnixInstallServer({
          executionTimeoutMilliseconds,
          activeOwner: new LinuxLogindActiveOwnerSessionProvider({
            inspectForProcess: async () => null,
          }),
          peerCredentials: {
            inspect: () => ({
              uid: 1,
              gid: 1,
              process: {
                pid: 1,
                isAlive: async () => true,
                close: () => undefined,
              },
            }),
          },
          service: {
            abortSemantics: "confirmed-stop-or-lock-retained",
            execute: async () => Promise.reject(new Error("unreachable")),
          },
        }),
      ).toThrow("execution timeout");
    },
  );

  it("rejects overload directly at the bounded adapter gate", () => {
    const gate = new InstallerRequestGate(1);
    const leave = gate.tryEnter();
    expect(leave).not.toBeNull();
    expect(gate.tryEnter()).toBeNull();
    leave?.();
    expect(gate.tryEnter()).not.toBeNull();
  });

  it("destroys an overloaded socket without emitting an Error", () => {
    const destroy = vi.fn();
    rejectOverloadedUnixSocket({ destroy } as unknown as Parameters<
      typeof rejectOverloadedUnixSocket
    >[0]);
    expect(destroy).toHaveBeenCalledWith();
  });

  it("refuses a handler without confirmed cancellation or retained-lock semantics", () => {
    expect(() =>
      createUnixInstallServer({
        activeOwner: new LinuxLogindActiveOwnerSessionProvider({
          inspectForProcess: async () => null,
        }),
        peerCredentials: {
          inspect: () => ({
            uid: 1,
            gid: 1,
            process: {
              pid: 1,
              isAlive: async () => true,
              close: () => undefined,
            },
          }),
        },
        service: {
          execute: async () => Promise.reject(new Error("unreachable")),
        } as unknown as UnixInstallService,
      }),
    ).toThrow("retained target locks");
  });

  it("binds a single framed request to atomic kernel peer credentials", async ({
    skip,
  }) => {
    let test: Awaited<ReturnType<typeof fixture>>;
    try {
      test = await fixture();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The test sandbox prohibits AF_UNIX listeners.");
        return;
      }
      throw error;
    }
    try {
      await expect(
        exchange(test.socketPath, frame(requestBytes())),
      ).resolves.toMatchObject({
        ok: true,
      });
      expect(test.getPeer()).toMatchObject({
        transport: "unix",
        uid: 1000,
        gid: 1000,
        process: { pid: 4321 },
      });
      expect(test.getExecutions()).toBe(1);
    } finally {
      test.server.close();
    }
  });

  it("rejects trailing bytes without dispatching the service", async ({
    skip,
  }) => {
    let test: Awaited<ReturnType<typeof fixture>>;
    try {
      test = await fixture();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The test sandbox prohibits AF_UNIX listeners.");
        return;
      }
      throw error;
    }
    try {
      await expect(
        exchange(test.socketPath, frame(requestBytes(), Buffer.from("x"))),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("trailing"),
      });
      expect(test.getExecutions()).toBe(0);
    } finally {
      test.server.close();
    }
  });

  it("allows execution to outlive the frame deadline after admission", async ({
    skip,
  }) => {
    let test: Awaited<ReturnType<typeof fixture>>;
    try {
      test = await fixture({
        frameTimeoutMilliseconds: 50,
        executionTimeoutMilliseconds: 1_000,
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            planId: "plan",
            completedActions: 0,
            finalInventoryFingerprint: "inventory",
          };
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The test sandbox prohibits AF_UNIX listeners.");
        return;
      }
      throw error;
    }
    try {
      await expect(
        exchange(test.socketPath, frame(requestBytes())),
      ).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      test.server.close();
    }
  });

  it("aborts timed-out work through the required lock-retaining service contract", async ({
    skip,
  }) => {
    let aborted = false;
    let test: Awaited<ReturnType<typeof fixture>>;
    try {
      test = await fixture({
        executionTimeoutMilliseconds: 1_000,
        execute: async (_peer, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve({
                  planId: "plan",
                  completedActions: 0,
                  finalInventoryFingerprint: "inventory",
                });
              },
              { once: true },
            );
          }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The test sandbox prohibits AF_UNIX listeners.");
        return;
      }
      throw error;
    }
    try {
      await expect(
        exchange(test.socketPath, frame(requestBytes())),
      ).rejects.toThrow();
      expect(aborted).toBe(true);
    } finally {
      test.server.close();
    }
  });

  it("fails if the kernel handle dies while logind is resolving the session", async () => {
    const liveness = [true, false];
    const handle = {
      pid: 42,
      isAlive: async () => liveness.shift() ?? false,
      close: () => undefined,
    };
    const provider = new LinuxLogindActiveOwnerSessionProvider({
      inspectForProcess: async (_process, uid) => ({
        ownerId: "owner",
        uid,
        sessionId: "session",
        active: true,
        locked: false,
      }),
    });
    const process = provider.bindPeer({
      uid: 1000,
      gid: 1000,
      process: handle,
    });
    await expect(provider.inspectForProcess(process)).resolves.toBeNull();
  });
});
