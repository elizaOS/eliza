import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createFetchHandler, type FetchHandler } from "../../server";
import { DependencyManager } from "../dependencies/dep-manager";
import type {
  DependencyCheckResult,
  DependencyId,
} from "../dependencies/types";

// End-to-end test for the /dependencies routes. Boots a real `node:http`
// server on an ephemeral port, adapts each incoming request to a WHATWG
// `Request`, runs it through the exact handler that production uses, then
// returns the resulting `Response` over the wire. Tests speak real HTTP via
// `fetch`. Probes are injected so the test never touches the host's real
// `which`/`brew`/`apt`.
//
// We adapt to node:http instead of calling `Bun.serve` because vitest runs
// under node, where `globalThis.Bun` is absent. The handler under test is
// byte-for-byte the same function `Bun.serve` invokes in production.

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

interface Booted {
  server: Server;
  url: string;
}

async function bootServer(host: HostState): Promise<Booted> {
  const handler: FetchHandler = createFetchHandler({
    depManager: buildManager(host),
  });

  const server = createHttpServer((nodeReq, nodeRes) => {
    const chunks: Buffer[] = [];
    nodeReq.on("data", (chunk: Buffer) => chunks.push(chunk));
    nodeReq.on("end", async () => {
      const method = nodeReq.method ?? "GET";
      const host = nodeReq.headers.host ?? "127.0.0.1";
      const url = `http://${host}${nodeReq.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(nodeReq.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else if (typeof v === "string") {
          headers.set(k, v);
        }
      }
      const init: RequestInit = { method, headers };
      if (method !== "GET" && method !== "HEAD" && chunks.length > 0) {
        init.body = Buffer.concat(chunks);
      }
      const req = new Request(url, init);
      const res = await handler(req);
      nodeRes.statusCode = res.status;
      res.headers.forEach((value, key) => {
        nodeRes.setHeader(key, value);
      });
      const buf = Buffer.from(await res.arrayBuffer());
      nodeRes.end(buf);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

describe("dependencies HTTP e2e", () => {
  // Each scenario boots its own server so probe state is isolated. We collect
  // them for teardown.
  const booted: Booted[] = [];

  afterAll(async () => {
    await Promise.all(
      booted.map(
        (b) =>
          new Promise<void>((resolve, reject) =>
            b.server.close((err) => (err ? reject(err) : resolve())),
          ),
      ),
    );
  });

  it("GET /dependencies returns an array of statuses for all known deps", async () => {
    const host: HostState = {
      installed: new Set(["adb", "fastboot"]),
      installCalls: [],
      installResult: false,
    };
    const b = await bootServer(host);
    booted.push(b);

    const res = await fetch(`${b.url}/dependencies`);
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
    const b = await bootServer(host);
    booted.push(b);

    const res = await fetch(`${b.url}/dependencies/adb`);
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
    const b = await bootServer(host);
    booted.push(b);

    const res = await fetch(`${b.url}/dependencies/adb/install`, {
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
    const b = await bootServer(host);
    booted.push(b);

    const res = await fetch(`${b.url}/dependencies/adb/install`, {
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
    const b = await bootServer(host);
    booted.push(b);

    const res = await fetch(`${b.url}/dependencies/adb/install`, {
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
