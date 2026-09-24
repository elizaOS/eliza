// Exercises the AOSP setup flasher backend and dependency gates.
import { describe, expect, it } from "vitest";
import { createFetchHandler, type FetchHandler } from "../../server";
import { DependencyManager } from "../dependencies/dep-manager";
import type {
  DependencyCheckResult,
  DependencyId,
} from "../dependencies/types";

// Integration test for the /dependencies routes. It sends WHATWG Requests to
// the exact fetch handler that Bun.serve invokes in production. Avoiding a
// test-only node:http adapter keeps the suite deterministic in restricted CI
// sandboxes where binding even an ephemeral loopback socket is prohibited.
// Probes are injected so the test never touches real which/brew/apt state.

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
    isWingetAvailable: async () => true,
    downloadPlatformTools: async () => false,
    downloadSideloader: async () => false,
  });
}

function bootHandler(host: HostState): FetchHandler {
  return createFetchHandler({
    depManager: buildManager(host),
  });
}

describe("dependencies HTTP handler integration", () => {
  it("GET /dependencies returns an array of statuses for all known deps", async () => {
    const host: HostState = {
      installed: new Set(["adb", "fastboot"]),
      installCalls: [],
      installResult: false,
    };
    const res = await bootHandler(host)(
      new Request("http://setup.test/dependencies"),
    );
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
    const res = await bootHandler(host)(
      new Request("http://setup.test/dependencies/adb"),
    );
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
    const res = await bootHandler(host)(
      new Request("http://setup.test/dependencies/adb/install", {
        method: "POST",
      }),
    );
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
    const res = await bootHandler(host)(
      new Request("http://setup.test/dependencies/adb/install", {
        method: "POST",
      }),
    );
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
    const res = await bootHandler(host)(
      new Request("http://setup.test/dependencies/adb/install", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DependencyCheckResult;
    expect(body.id).toBe("adb");
    expect(body.status).toBe("install-failed");
    expect(body.errorMessage).toBeDefined();
    expect(body.errorMessage).toContain("Auto-install failed");
    expect(body.manualInstructions).toBeDefined();
  });
});
