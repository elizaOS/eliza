import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../../../apps/app-steward/src/services/steward-sidecar/health-check.ts",
  () => ({
    waitForHealthy: vi.fn(async () => undefined),
  }),
);

vi.mock(
  "../../../../apps/app-steward/src/services/steward-sidecar/process-management.ts",
  () => ({
    ensureStewardWorkspaceReady: vi.fn(async () => undefined),
    findStewardEntryPoint: vi.fn(
      async () => "/Users/home/milady/steward-fi/packages/api/src/embedded.ts",
    ),
    pipeOutput: vi.fn(async () => undefined),
  }),
);

vi.mock(
  "../../../../apps/app-steward/src/services/steward-sidecar/wallet-setup.ts",
  () => ({
    ensureWalletSetup: vi.fn(async () => ({
      tenantId: "milady-desktop",
      tenantApiKey: "tenant-key",
      agentId: "milady-wallet",
      agentToken: "agent-token",
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      masterPassword: "",
    })),
  }),
);

describe("StewardSidecar", () => {
  const originalHome = process.env.HOME;
  const originalBun = (globalThis as { Bun?: unknown }).Bun;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalBun === undefined) {
      delete (globalThis as { Bun?: unknown }).Bun;
    } else {
      (globalThis as { Bun?: unknown }).Bun = originalBun;
    }

    vi.clearAllMocks();
  });

  it("uses Milady's steward data dir for PGLite and migrates legacy local data", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-steward-"));
    process.env.HOME = homeDir;

    const legacyDataDir = path.join(homeDir, ".steward", "data");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, "PG_VERSION"), "17");

    let resolveExit: ((code: number) => void) | null = null;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const spawnMock = vi.fn(() => ({
      kill: vi.fn(() => resolveExit?.(0)),
      pid: 1234,
      stdout: null,
      stderr: null,
      exited,
    }));
    (globalThis as { Bun?: unknown }).Bun = {
      spawn: spawnMock,
    };

    const { StewardSidecar } = await import(
      "../../../../apps/app-steward/src/services/steward-sidecar"
    );

    const dataDir = path.join(homeDir, ".milady", "steward");
    const sidecar = new StewardSidecar({ dataDir });
    await sidecar.start();
    await sidecar.stop();

    expect(fs.existsSync(path.join(dataDir, "data", "PG_VERSION"))).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      [
        "bun",
        "run",
        "/Users/home/milady/steward-fi/packages/api/src/embedded.ts",
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          STEWARD_DATA_DIR: path.join(dataDir, "data"),
          STEWARD_PGLITE_PATH: path.join(dataDir, "data"),
        }),
      }),
    );
  });

  it("reallocates the steward port when the preferred loopback port is busy", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-steward-"));
    process.env.HOME = homeDir;

    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blocker.address();
    const busyPort =
      address && typeof address === "object" ? address.port : null;
    expect(busyPort).not.toBeNull();

    let resolveExit: ((code: number) => void) | null = null;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const spawnMock = vi.fn(() => ({
      kill: vi.fn(() => resolveExit?.(0)),
      pid: 5678,
      stdout: null,
      stderr: null,
      exited,
    }));
    (globalThis as { Bun?: unknown }).Bun = {
      spawn: spawnMock,
    };

    const { StewardSidecar } = await import(
      "../../../../apps/app-steward/src/services/steward-sidecar"
    );

    const dataDir = path.join(homeDir, ".milady", "steward");
    const sidecar = new StewardSidecar({
      dataDir,
      port: busyPort ?? 0,
    });

    try {
      await sidecar.start();

      const spawnEnv = spawnMock.mock.calls[0]?.[1]?.env as
        | Record<string, string>
        | undefined;
      expect(spawnEnv).toBeDefined();
      expect(Number(spawnEnv?.PORT)).toBeGreaterThan(busyPort ?? 0);
      expect(sidecar.getStatus().port).toBeGreaterThan(busyPort ?? 0);
    } finally {
      await sidecar.stop();
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
