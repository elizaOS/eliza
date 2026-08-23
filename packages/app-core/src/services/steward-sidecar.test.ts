/**
 * Behavioral coverage for `StewardSidecar` and the public barrel in
 * `steward-sidecar.ts`: constructor accessors, factory env/override
 * precedence, credential load, missing entry, legacy data migration, and a
 * real loopback child for start/stop/restart/crash. Drives the real module
 * against temp directories and a tiny HTTP stand-in; no collaborator mocks.
 */

import fs from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allocateFirstFreeLoopbackPort,
  createDesktopStewardSidecar,
  fingerprintRandomToken,
  generateApiKey,
  generateMasterPassword,
  resolveDataDir,
  type StewardCredentials,
  StewardSidecar,
  type StewardSidecarStatus,
} from "./steward-sidecar";

const ENV_KEYS = [
  "STEWARD_DATA_DIR",
  "STEWARD_PORT",
  "STEWARD_MASTER_PASSWORD",
  "STEWARD_ENTRY_POINT",
  "DATABASE_URL",
  "ELIZA_NAMESPACE",
  "XDG_STATE_HOME",
  "HOME",
  "USERPROFILE",
] as const;

const FAKE_STEWARD_SOURCE = `import http from "node:http";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT is required");
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  req.resume();
  req.on("end", () => {
    if (method === "GET" && url === "/health") {
      send(200, { status: "ok" });
      return;
    }
    if (method === "POST" && url === "/tenants") {
      send(200, { ok: true });
      return;
    }
    if (method === "POST" && url === "/agents") {
      send(200, {
        ok: true,
        data: { id: "eliza-wallet", walletAddress: "0xfakewallet" },
      });
      return;
    }
    if (method === "POST" && url.endsWith("/token") && url.includes("/agents/")) {
      send(200, { ok: true, data: { token: "fake-agent-token" } });
      return;
    }
    if (method === "GET" && url.startsWith("/agents/")) {
      send(200, { ok: true, data: { walletAddress: "0xfakewallet" } });
      return;
    }
    send(404, { error: "not found" });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("fake-steward-listening");
});
`;

const plantedCredentials: StewardCredentials = {
  tenantId: "tenant-1",
  tenantApiKey: "tenant-key-1",
  agentId: "agent-1",
  agentToken: "agent-token-1",
  walletAddress: "0xplanted",
};

const tempDirs: string[] = [];
const servers: Server[] = [];
const sidecars: StewardSidecar[] = [];
let envSnapshot: Record<string, string | undefined>;

function openTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function track(sidecar: StewardSidecar): StewardSidecar {
  sidecars.push(sidecar);
  return sidecar;
}

function writeFakeSteward(dir: string): string {
  const entry = path.join(dir, "fake-steward.mjs");
  fs.writeFileSync(entry, FAKE_STEWARD_SOURCE, "utf8");
  return entry;
}

function plantCredentials(dataDir: string, credentials: object): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "credentials.json"),
    JSON.stringify(credentials, null, 2),
    "utf8",
  );
}

function occupyPort(port: number): Promise<Server> {
  const server = createServer();
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      resolve(server),
    );
  });
}

async function waitForStatus(
  sidecar: StewardSidecar,
  predicate: (status: StewardSidecarStatus) => boolean,
  timeoutMs = 8_000,
): Promise<StewardSidecarStatus> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = sidecar.getStatus();
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for sidecar status: ${JSON.stringify(sidecar.getStatus())}`,
  );
}

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
  delete process.env.STEWARD_ENTRY_POINT;
});

afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) {
    await sidecar.stop();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }
});

describe("re-exported helpers", () => {
  it("expands a leading tilde via HOME and leaves other paths unchanged", () => {
    process.env.HOME = "/tmp/sidecar-home";
    expect(resolveDataDir("~/data")).toBe("/tmp/sidecar-home/data");
    expect(resolveDataDir("/abs/path")).toBe("/abs/path");
    expect(resolveDataDir("rel/path")).toBe("rel/path");
  });

  it("falls back to USERPROFILE when HOME is unset", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "/users/win";
    expect(resolveDataDir("~/wallet")).toBe("/users/win/wallet");
  });

  it("generates distinct stw_ hex API keys and 64-char hex master passwords", () => {
    const key = generateApiKey();
    expect(key.startsWith("stw_")).toBe(true);
    expect(key.length).toBe(4 + 64);
    expect(generateApiKey()).not.toBe(key);

    const password = generateMasterPassword();
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(generateMasterPassword()).not.toBe(password);
  });

  it("fingerprints tokens as a deterministic sha256 hex digest", () => {
    const digest = fingerprintRandomToken("token-123");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintRandomToken("token-123")).toBe(digest);
    expect(fingerprintRandomToken("token-124")).not.toBe(digest);
  });

  it("allocates the preferred loopback port when it is free", async () => {
    const preferred = await allocateFirstFreeLoopbackPort(49152);
    expect(preferred).toBeGreaterThanOrEqual(49152);
    expect(preferred).toBeLessThanOrEqual(65535);
    expect(await allocateFirstFreeLoopbackPort(preferred)).toBe(preferred);
  });

  it("hops to the next free port when the preferred port is occupied", async () => {
    const preferred = await allocateFirstFreeLoopbackPort(49200);
    await occupyPort(preferred);
    const allocated = await allocateFirstFreeLoopbackPort(preferred);
    expect(allocated).toBeGreaterThan(preferred);
  });

  it("rejects invalid preferred ports and an exhausted hop window", async () => {
    await expect(allocateFirstFreeLoopbackPort(0)).rejects.toThrow(
      /Invalid preferred port: 0/,
    );
    await expect(allocateFirstFreeLoopbackPort(65536)).rejects.toThrow(
      /Invalid preferred port: 65536/,
    );
    await expect(allocateFirstFreeLoopbackPort(Number.NaN)).rejects.toThrow(
      /Invalid preferred port/,
    );

    const preferred = await allocateFirstFreeLoopbackPort(49300);
    await occupyPort(preferred);
    await occupyPort(preferred + 1);
    await expect(
      allocateFirstFreeLoopbackPort(preferred, { maxHops: 2 }),
    ).rejects.toThrow(
      new RegExp(
        `No free TCP port on 127\\.0\\.0\\.1 in range ${preferred}-${preferred + 1}`,
      ),
    );
  });
});

describe("StewardSidecar constructor and accessors", () => {
  it("starts stopped with a copied status snapshot and null credentials", () => {
    const sidecar = track(
      new StewardSidecar({ dataDir: openTempDir("steward-sidecar-status-") }),
    );

    expect(sidecar.getStatus()).toEqual({
      state: "stopped",
      port: null,
      pid: null,
      error: null,
      restartCount: 0,
      walletAddress: null,
      agentId: null,
      tenantId: null,
      startedAt: null,
    });
    expect(sidecar.getApiBase()).toBe("http://127.0.0.1:3200");
    expect(sidecar.getCredentials()).toBeNull();
    expect(sidecar.getTenantApiKey()).toBeNull();
    expect(sidecar.getAgentToken()).toBeNull();

    const snapshot = sidecar.getStatus();
    snapshot.state = "running";
    snapshot.restartCount = 9;
    snapshot.port = 1;
    expect(sidecar.getStatus().state).toBe("stopped");
    expect(sidecar.getStatus().restartCount).toBe(0);
    expect(sidecar.getStatus().port).toBeNull();
  });

  it("honours an explicit port and expands ~ in dataDir before start", async () => {
    const home = openTempDir("steward-sidecar-home-");
    process.env.HOME = home;
    const sidecar = track(
      new StewardSidecar({
        dataDir: "~/wallet-state",
        port: 43123,
      }),
    );

    expect(sidecar.getApiBase()).toBe("http://127.0.0.1:43123");
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(fs.existsSync(path.join(home, "wallet-state", "data"))).toBe(true);
    expect(fs.existsSync(path.join(home, "wallet-state", "logs"))).toBe(true);
  });

  it("stop() on a never-started sidecar stays stopped without inventing a port", async () => {
    const sidecar = track(
      new StewardSidecar({ dataDir: openTempDir("steward-sidecar-stop-") }),
    );
    await sidecar.stop();
    expect(sidecar.getStatus()).toMatchObject({
      state: "stopped",
      port: null,
      pid: null,
      startedAt: null,
    });
  });
});

describe("createDesktopStewardSidecar", () => {
  it("defaults to port 3200 and ~/.local/state/<namespace>/steward", async () => {
    const home = openTempDir("steward-sidecar-factory-home-");
    process.env.HOME = home;
    delete process.env.STEWARD_DATA_DIR;
    delete process.env.STEWARD_PORT;
    delete process.env.XDG_STATE_HOME;
    delete process.env.ELIZA_NAMESPACE;

    const sidecar = track(createDesktopStewardSidecar());
    expect(sidecar.getApiBase()).toBe("http://127.0.0.1:3200");
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(
      fs.existsSync(
        path.join(home, ".local", "state", "eliza", "steward", "data"),
      ),
    ).toBe(true);
  });

  it("treats a whitespace-only XDG_STATE_HOME as unset", async () => {
    const home = openTempDir("steward-sidecar-xdg-blank-");
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = "   ";
    delete process.env.STEWARD_DATA_DIR;
    delete process.env.ELIZA_NAMESPACE;

    const sidecar = track(createDesktopStewardSidecar());
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(
      fs.existsSync(
        path.join(home, ".local", "state", "eliza", "steward", "data"),
      ),
    ).toBe(true);
  });

  it("joins a relative XDG_STATE_HOME with HOME and honours ELIZA_NAMESPACE", async () => {
    const home = openTempDir("steward-sidecar-xdg-rel-");
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = ".xdg-state";
    process.env.ELIZA_NAMESPACE = "custom-ns";
    delete process.env.STEWARD_DATA_DIR;

    const sidecar = track(createDesktopStewardSidecar());
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(
      fs.existsSync(
        path.join(home, ".xdg-state", "custom-ns", "steward", "data"),
      ),
    ).toBe(true);
  });

  it("uses an absolute XDG_STATE_HOME when STEWARD_DATA_DIR is absent", async () => {
    const home = openTempDir("steward-sidecar-xdg-abs-home-");
    const xdg = openTempDir("steward-sidecar-xdg-abs-");
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = xdg;
    delete process.env.STEWARD_DATA_DIR;
    delete process.env.ELIZA_NAMESPACE;

    const sidecar = track(createDesktopStewardSidecar());
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(fs.existsSync(path.join(xdg, "eliza", "steward", "data"))).toBe(
      true,
    );
  });

  it("prefers STEWARD_DATA_DIR over XDG state home", async () => {
    const explicit = openTempDir("steward-sidecar-explicit-");
    const xdg = openTempDir("steward-sidecar-xdg-ignored-");
    process.env.STEWARD_DATA_DIR = explicit;
    process.env.XDG_STATE_HOME = xdg;

    const sidecar = track(createDesktopStewardSidecar());
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(fs.existsSync(path.join(explicit, "data"))).toBe(true);
    expect(fs.existsSync(path.join(xdg, "eliza", "steward"))).toBe(false);
  });

  it("lets explicit overrides win over env because ...overrides is last", async () => {
    const fromEnv = openTempDir("steward-sidecar-env-dir-");
    const fromOverride = openTempDir("steward-sidecar-override-dir-");
    process.env.STEWARD_DATA_DIR = fromEnv;
    process.env.STEWARD_PORT = "4500";

    const sidecar = track(
      createDesktopStewardSidecar({
        dataDir: fromOverride,
        port: 4600,
      }),
    );
    expect(sidecar.getApiBase()).toBe("http://127.0.0.1:4600");
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(fs.existsSync(path.join(fromOverride, "data"))).toBe(true);
    expect(fs.existsSync(path.join(fromEnv, "data"))).toBe(false);
  });

  it("reads STEWARD_PORT when no override port is supplied", () => {
    process.env.STEWARD_PORT = "4500";
    const sidecar = track(
      createDesktopStewardSidecar({
        dataDir: openTempDir("steward-sidecar-port-env-"),
      }),
    );
    expect(sidecar.getApiBase()).toBe("http://127.0.0.1:4500");
  });

  it("falls through invalid or zero STEWARD_PORT to the override, then 3200", () => {
    const dataDir = openTempDir("steward-sidecar-port-fallback-");
    process.env.STEWARD_PORT = "abc";
    expect(
      track(createDesktopStewardSidecar({ dataDir, port: 4700 })).getApiBase(),
    ).toBe("http://127.0.0.1:4700");

    process.env.STEWARD_PORT = "0";
    expect(track(createDesktopStewardSidecar({ dataDir })).getApiBase()).toBe(
      "http://127.0.0.1:3200",
    );
  });
});

describe("start without a steward entry", () => {
  it("rejects, records error state, and still creates data and logs", async () => {
    const dataDir = openTempDir("steward-sidecar-missing-entry-");
    const seen: string[] = [];
    const sidecar = track(
      new StewardSidecar({
        dataDir,
        onStatusChange: (status) => {
          seen.push(status.state);
        },
      }),
    );

    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(sidecar.getStatus().state).toBe("error");
    expect(sidecar.getStatus().error).toMatch(
      /Steward API entry point not found/,
    );
    expect(sidecar.getStatus().pid).toBeNull();
    expect(fs.existsSync(path.join(dataDir, "data"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "logs"))).toBe(true);
    expect(seen[0]).toBe("starting");
    expect(seen).toContain("error");
  });

  it("coalesces concurrent start() calls onto one rejection", async () => {
    const sidecar = track(
      new StewardSidecar({
        dataDir: openTempDir("steward-sidecar-coalesce-"),
      }),
    );
    const [first, second] = await Promise.allSettled([
      sidecar.start(),
      sidecar.start(),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    if (first.status === "rejected" && second.status === "rejected") {
      expect(first.reason).toBe(second.reason);
      expect(String(first.reason)).toMatch(/Steward API entry point not found/);
    }
  });

  it("loads planted credentials into status and returns copies from getters", async () => {
    const dataDir = openTempDir("steward-sidecar-creds-");
    plantCredentials(dataDir, plantedCredentials);
    const sidecar = track(new StewardSidecar({ dataDir }));

    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(sidecar.getStatus()).toMatchObject({
      walletAddress: "0xplanted",
      agentId: "agent-1",
      tenantId: "tenant-1",
      state: "error",
    });
    expect(sidecar.getCredentials()).toEqual(plantedCredentials);
    expect(sidecar.getTenantApiKey()).toBe("tenant-key-1");
    expect(sidecar.getAgentToken()).toBe("agent-token-1");

    const copy = sidecar.getCredentials();
    expect(copy).not.toBeNull();
    if (copy === null) {
      throw new Error("expected planted credentials to load");
    }
    copy.tenantApiKey = "mutated";
    expect(sidecar.getTenantApiKey()).toBe("tenant-key-1");
  });

  it("fills a missing masterPassword from config and keeps one already on disk", async () => {
    const fillDir = openTempDir("steward-sidecar-pw-fill-");
    plantCredentials(fillDir, plantedCredentials);
    const filling = track(
      new StewardSidecar({
        dataDir: fillDir,
        masterPassword: "from-config",
      }),
    );
    await expect(filling.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(filling.getCredentials()?.masterPassword).toBe("from-config");

    const keepDir = openTempDir("steward-sidecar-pw-keep-");
    plantCredentials(keepDir, {
      ...plantedCredentials,
      masterPassword: "from-file",
    });
    const keeping = track(
      new StewardSidecar({
        dataDir: keepDir,
        masterPassword: "from-config",
      }),
    );
    await expect(keeping.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(keeping.getCredentials()?.masterPassword).toBe("from-file");
  });

  it("recreates after unreadable credentials instead of throwing a parse error", async () => {
    const dataDir = openTempDir("steward-sidecar-bad-json-");
    plantCredentials(dataDir, plantedCredentials);
    fs.writeFileSync(
      path.join(dataDir, "credentials.json"),
      "{not-json",
      "utf8",
    );
    const sidecar = track(new StewardSidecar({ dataDir }));

    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(sidecar.getCredentials()).toBeNull();
    expect(sidecar.getStatus().walletAddress).toBeNull();
  });

  it("stop() after a failed start marks stopped but does not clear the error", async () => {
    const sidecar = track(
      new StewardSidecar({
        dataDir: openTempDir("steward-sidecar-stop-after-error-"),
      }),
    );
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    await sidecar.stop();
    expect(sidecar.getStatus().state).toBe("stopped");
    expect(sidecar.getStatus().port).toBeNull();
    expect(sidecar.getStatus().pid).toBeNull();
    expect(sidecar.getStatus().startedAt).toBeNull();
    expect(sidecar.getStatus().error).toMatch(
      /Steward API entry point not found/,
    );
  });

  it("restart() of a never-started sidecar still fails on the missing entry", async () => {
    const sidecar = track(
      new StewardSidecar({
        dataDir: openTempDir("steward-sidecar-restart-missing-"),
      }),
    );
    await expect(sidecar.restart()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(sidecar.getStatus().restartCount).toBe(0);
    expect(sidecar.getStatus().state).toBe("error");
  });
});

describe("legacy steward data migration", () => {
  it("copies ~/.steward/data into an empty target data dir", async () => {
    const home = openTempDir("steward-sidecar-legacy-home-");
    process.env.HOME = home;
    const legacy = path.join(home, ".steward", "data");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "PG_VERSION"), "15\n", "utf8");

    const dataDir = path.join(home, "eliza-steward");
    const sidecar = track(new StewardSidecar({ dataDir }));
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(
      fs.readFileSync(path.join(dataDir, "data", "PG_VERSION"), "utf8"),
    ).toBe("15\n");
  });

  it("does not overwrite a target that already has data", async () => {
    const home = openTempDir("steward-sidecar-legacy-keep-");
    process.env.HOME = home;
    const legacy = path.join(home, ".steward", "data");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "PG_VERSION"), "15\n", "utf8");

    const dataDir = path.join(home, "eliza-steward");
    fs.mkdirSync(path.join(dataDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "data", "PG_VERSION"), "16\n", "utf8");

    const sidecar = track(new StewardSidecar({ dataDir }));
    await expect(sidecar.start()).rejects.toThrow(
      /Steward API entry point not found/,
    );
    expect(
      fs.readFileSync(path.join(dataDir, "data", "PG_VERSION"), "utf8"),
    ).toBe("16\n");
  });
});

describe("lifecycle with a real loopback steward", () => {
  async function startLiveSidecar(options?: {
    credentials?: object;
    maxRestarts?: number;
    occupyPreferred?: boolean;
    onLog?: (line: string, stream: "stdout" | "stderr") => void;
  }): Promise<{
    sidecar: StewardSidecar;
    preferred: number;
  }> {
    const dataDir = openTempDir("steward-sidecar-live-");
    if (options?.credentials) {
      plantCredentials(dataDir, options.credentials);
    }
    const preferred = await allocateFirstFreeLoopbackPort(49400);
    if (options?.occupyPreferred) {
      await occupyPort(preferred);
    }
    const sidecar = track(
      new StewardSidecar({
        dataDir,
        port: preferred,
        stewardEntryPoint: writeFakeSteward(dataDir),
        ...(options?.maxRestarts !== undefined
          ? { maxRestarts: options.maxRestarts }
          : {}),
        onLog: options?.onLog,
      }),
    );
    return { sidecar, preferred };
  }

  it("starts, reports running, persists first-launch credentials, and stops", async () => {
    const logs: string[] = [];
    const { sidecar, preferred } = await startLiveSidecar({
      onLog: (line) => {
        logs.push(line);
      },
    });

    const status = await sidecar.start();
    expect(status.state).toBe("running");
    expect(status.port).toBe(preferred);
    expect(status.pid).toEqual(expect.any(Number));
    expect(status.startedAt).toEqual(expect.any(Number));
    expect(status.walletAddress).toBe("0xfakewallet");
    expect(status.agentId).toBe("eliza-wallet");
    expect(status.tenantId).toBe("elizaos-desktop");
    expect(sidecar.getApiBase()).toBe(`http://127.0.0.1:${preferred}`);
    expect(sidecar.getAgentToken()).toBe("fake-agent-token");
    expect(sidecar.getTenantApiKey()).toMatch(/^stw_/);

    const creds = sidecar.getCredentials();
    expect(creds).not.toBeNull();
    if (creds === null) {
      throw new Error("expected first-launch credentials");
    }
    expect(creds.walletAddress).toBe("0xfakewallet");
    expect(creds.agentToken).toBe("fake-agent-token");
    expect(logs.some((line) => line.includes("fake-steward-listening"))).toBe(
      true,
    );

    const runningAgain = await sidecar.start();
    expect(runningAgain.startedAt).toBe(status.startedAt);
    expect(runningAgain.pid).toBe(status.pid);

    await sidecar.stop();
    expect(sidecar.getStatus().state).toBe("stopped");
    expect(sidecar.getStatus().pid).toBeNull();
    expect(sidecar.getStatus().port).toBeNull();
    expect(sidecar.getStatus().startedAt).toBeNull();
  }, 15_000);

  it("completes a planted checkpoint that is missing agentToken", async () => {
    const { sidecar } = await startLiveSidecar({
      credentials: {
        tenantId: "tenant-1",
        tenantApiKey: "tenant-key-1",
        agentId: "agent-1",
        walletAddress: "0xcheckpoint",
      },
    });
    const status = await sidecar.start();
    expect(status.state).toBe("running");
    expect(sidecar.getAgentToken()).toBe("fake-agent-token");
    expect(sidecar.getCredentials()?.walletAddress).toBe("0xcheckpoint");
  }, 15_000);

  it("verifies an already-complete planted wallet and updates the address from GET /agents", async () => {
    const { sidecar } = await startLiveSidecar({
      credentials: plantedCredentials,
    });
    const status = await sidecar.start();
    expect(status.state).toBe("running");
    expect(status.walletAddress).toBe("0xfakewallet");
    expect(sidecar.getAgentToken()).toBe("agent-token-1");
  }, 15_000);

  it("hops off a busy preferred port", async () => {
    const { sidecar, preferred } = await startLiveSidecar({
      occupyPreferred: true,
    });
    const status = await sidecar.start();
    expect(status.state).toBe("running");
    expect(status.port).not.toBe(preferred);
    expect(sidecar.getApiBase()).toBe(`http://127.0.0.1:${status.port}`);
  }, 15_000);

  it("restart() returns to running and zeroes restartCount", async () => {
    const states: StewardSidecarStatus["state"][] = [];
    const dataDir = openTempDir("steward-sidecar-restart-");
    const preferred = await allocateFirstFreeLoopbackPort(49400);
    const sidecar = track(
      new StewardSidecar({
        dataDir,
        port: preferred,
        stewardEntryPoint: writeFakeSteward(dataDir),
        onStatusChange: (status) => {
          states.push(status.state);
        },
      }),
    );
    await sidecar.start();
    const restarted = await sidecar.restart();
    expect(restarted.state).toBe("running");
    expect(restarted.restartCount).toBe(0);
    expect(restarted.pid).toEqual(expect.any(Number));
    expect(states).toContain("stopped");
    expect(
      states.filter((state) => state === "running").length,
    ).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("gives up immediately when maxRestarts is 0 after an unexpected exit", async () => {
    const { sidecar } = await startLiveSidecar({ maxRestarts: 0 });
    const status = await sidecar.start();
    expect(status.pid).toEqual(expect.any(Number));
    if (status.pid === null) {
      throw new Error("expected a live pid");
    }
    process.kill(status.pid, "SIGKILL");
    const failed = await waitForStatus(
      sidecar,
      (current) => current.state === "error",
    );
    expect(failed.error).toMatch(/Steward crashed 1 times/);
    expect(failed.pid).toBeNull();
    expect(failed.restartCount).toBe(1);
  }, 15_000);

  it("respawns after an unexpected exit when restarts remain", async () => {
    const { sidecar } = await startLiveSidecar({ maxRestarts: 2 });
    const first = await sidecar.start();
    if (first.pid === null) {
      throw new Error("expected a live pid");
    }
    process.kill(first.pid, "SIGKILL");
    const recovered = await waitForStatus(
      sidecar,
      (current) =>
        current.state === "running" &&
        current.restartCount === 1 &&
        current.error === null &&
        current.pid !== null,
      12_000,
    );
    expect(recovered.port).toBe(first.port);
  }, 20_000);
});
