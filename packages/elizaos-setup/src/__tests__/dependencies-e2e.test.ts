import type { Server } from "bun";
import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "../../server";
import { DependencyManager } from "../dependencies/dep-manager";
import type {
  DependencyCheckResult,
  DependencyId,
} from "../dependencies/types";

// End-to-end test for the /dependencies routes. Boots a real Bun.serve on an
// ephemeral port, talks to it over real HTTP with fetch, and exercises the
// route → DependencyManager → JSON wire-up. Probes are injected so the test
// never touches the host's real `which`/`brew`/`apt`.

type BunServer = Server<undefined>;

interface HostState {
  /** Binaries currently "installed" on the simulated host. */
  installed: Set<string>;
  /** Log of install argv calls. */
  installCalls: string[][];
  /** What the install runner should return for the next call. */
  installResult: boolean;
  /**
   * If set, the simulated installer "places" this binary into `installed`
   * before returning. Mirrors the real-world "install succeeded and binary
   * appeared on PATH" path.
   */
  installPlaces?: string;
}

function buildManager(host: HostState): DependencyManager {
  return new DependencyManager({
    whichBinary: (name) =>
      host.installed.has(name) ? `/fake/bin/${name}` : undefined,
    runInstallCommand: async (argv) => {
      host.installCalls.push(argv);
      if (host.installResult && host.installPlaces) {
        host.installed.add(host.installPlaces);
      }
      return host.installResult;
    },
  });
}

function bootServer(host: HostState): BunServer {
  return createServer({ port: 0, depManager: buildManager(host) });
}

function baseUrl(server: BunServer): string {
  return `http://127.0.0.1:${server.port}`;
}

describe("dependencies HTTP e2e", () => {
  // Each scenario boots its own server so probe state is isolated. We collect
  // them for teardown.
  const servers: BunServer[] = [];

  afterAll(() => {
    for (const s of servers) s.stop(true);
  });

  it("GET /dependencies returns an array of statuses for all known deps", async () => {
    const host: HostState = {
      installed: new Set(["adb", "fastboot"]),
      installCalls: [],
      installResult: false,
    };
    const server = bootServer(host);
    servers.push(server);

    const res = await fetch(`${baseUrl(server)}/dependencies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DependencyCheckResult[];
    expect(Array.isArray(body)).toBe(true);
    const ids = body.map((r) => r.id).sort();
    expect(ids).toEqual([
      "adb",
      "fastboot",
      "libimobiledevice",
      "sideloader",
    ] satisfies DependencyId[]);

    const adb = body.find((r) => r.id === "adb");
    expect(adb?.status).toBe("found");
    const sideloader = body.find((r) => r.id === "sideloader");
    expect(sideloader?.status).toBe("missing");
    expect(sideloader?.manualInstructions).toBeDefined();
  });

  it("GET /dependencies/:id returns the single dep status", async () => {
    const host: HostState = {
      installed: new Set(["adb"]),
      installCalls: [],
      installResult: false,
    };
    const server = bootServer(host);
    servers.push(server);

    const res = await fetch(`${baseUrl(server)}/dependencies/adb`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DependencyCheckResult;
    expect(body.id).toBe("adb");
    expect(body.status).toBe("found");
    expect(body.foundPath).toBe("/fake/bin/adb");
  });

  it("POST /dependencies/:id/install — install succeeds and binary appears → status 'found'", async () => {
    const host: HostState = {
      installed: new Set(),
      installCalls: [],
      installResult: true,
      installPlaces: "adb",
    };
    const server = bootServer(host);
    servers.push(server);

    const res = await fetch(`${baseUrl(server)}/dependencies/adb/install`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DependencyCheckResult;
    expect(body.id).toBe("adb");
    expect(body.status).toBe("found");
    expect(body.foundPath).toBe("/fake/bin/adb");
    expect(host.installCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /dependencies/:id/install — install exits 0 but binary missing → status 'install-failed' (catches 'lying install' bug)", async () => {
    const host: HostState = {
      installed: new Set(),
      installCalls: [],
      // Installer reports success but never places the binary — exactly the
      // brew/apt/winget "0 exit, no binary on PATH" failure mode the
      // post-install re-probe was added to catch.
      installResult: true,
    };
    const server = bootServer(host);
    servers.push(server);

    const res = await fetch(`${baseUrl(server)}/dependencies/adb/install`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DependencyCheckResult;
    expect(body.id).toBe("adb");
    expect(body.status).toBe("install-failed");
    expect(body.errorMessage).toBeDefined();
    expect(body.errorMessage).toContain("reported success");
    expect(body.errorMessage).toContain("still not on PATH");
    expect(body.manualInstructions).toBeDefined();
  });

  it("POST /dependencies/:id/install — install command exits non-zero → status 'install-failed'", async () => {
    const host: HostState = {
      installed: new Set(),
      installCalls: [],
      installResult: false,
    };
    const server = bootServer(host);
    servers.push(server);

    const res = await fetch(`${baseUrl(server)}/dependencies/adb/install`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DependencyCheckResult;
    expect(body.id).toBe("adb");
    expect(body.status).toBe("install-failed");
    expect(body.errorMessage).toBeDefined();
    expect(body.errorMessage).toContain("Auto-install failed");
    expect(body.manualInstructions).toBeDefined();
  });
});
