/**
 * Drives the production agent registry client and plugin installer against a
 * real resettable HTTP marketplace/npm upstream. No client method, package
 * manager, response, or installed artifact is mocked.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installPluginWithRuntime } from "../../../agent/src/services/plugin-installer.ts";
import {
  createFileRegistryCacheStore,
  RegistryClient,
} from "../../../agent/src/services/registry-client.ts";
import {
  fetchRegistrySnapshot,
  MAX_REGISTRY_JSON_BYTES,
  MAX_REGISTRY_JSON_DEPTH,
  MAX_REGISTRY_JSON_NODES,
  MAX_REGISTRY_JSON_STRING_BYTES,
  MAX_REGISTRY_JSON_WIDTH,
  RegistryUpstreamError,
} from "../../../agent/src/services/registry-client-network.ts";
import {
  type RegistryMockFault,
  startRegistryMock,
} from "../src/registry/index.ts";

const temporaryDirectories: string[] = [];
const runningServers: Array<{ stop(): Promise<void> }> = [];
const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalConfigPath = process.env.ELIZA_CONFIG_PATH;

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = originalStateDir;
  if (originalConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = originalConfigPath;
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function harness(options: { timeoutMs?: number; ttlMs?: number } = {}) {
  const upstream = await startRegistryMock();
  runningServers.push(upstream);
  const state = await temporaryDirectory("eliza-registry-protocol-");
  const client = new RegistryClient({
    generatedRegistryUrl: upstream.generatedRegistryUrl,
    indexRegistryUrl: upstream.indexRegistryUrl,
    cacheStore: createFileRegistryCacheStore(path.join(state, "registry.json")),
    now: upstream.now,
    cacheTtlMs: options.ttlMs ?? 100,
    timeoutMs: options.timeoutMs ?? 1_000,
    cloudReachable: async () => true,
    applyLocalWorkspaceApps: async () => {},
    applyNodeModulePlugins: async () => {},
    sanitizeSandbox: (value) => value ?? "allow-scripts",
    getConfiguredEndpoints: () => [],
    mergeCustomEndpoints: async () => {},
  });
  return { upstream, state, client };
}

describe("registry marketplace protocol", () => {
  it("rejects unsafe endpoint seams before transport", async () => {
    let fetchCalls = 0;
    await expect(
      fetchRegistrySnapshot({
        generatedRegistryUrl: "http://attacker.example/generated-registry.json",
        indexRegistryUrl: "https://plugins.eliza.app/index.json",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response();
        },
        cloudReachable: async () => true,
        applyLocalWorkspaceApps: async () => {},
        applyNodeModulePlugins: async () => {},
        sanitizeSandbox: (value) => value ?? "allow-scripts",
      }),
    ).rejects.toBeInstanceOf(RegistryUpstreamError);
    expect(fetchCalls).toBe(0);
  });

  it("uses ETag/304 after virtual TTL expiry and singleflights concurrent callers", async () => {
    const { upstream, client } = await harness();

    const [first, second, third] = await Promise.all([
      client.getRegistryPlugins(),
      client.getRegistryPlugins(),
      client.getRegistryPlugins(),
    ]);
    expect(first).toStrictEqual(second);
    expect(second).toStrictEqual(third);
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    expect(first.get("@synthetic/plugin-weather")?.npm.v2Version).toBe("1.0.0");
    expect(upstream.readback().observations).toMatchObject([
      { path: "/generated-registry.json", status: 200, ifNoneMatch: null },
    ]);

    upstream.advanceTime(101);
    const validated = await client.getRegistryPlugins();
    expect(validated.get("@synthetic/plugin-weather")?.description).toContain(
      "synthetic weather",
    );
    expect(upstream.readback().observations).toMatchObject([
      { status: 200, ifNoneMatch: null },
      { status: 304, ifNoneMatch: expect.stringMatching(/^"sha256-/) },
    ]);
  });

  it("falls back to index only for generated 404", async () => {
    const { upstream, client } = await harness();
    upstream.enqueueFault("/generated-registry.json", {
      kind: "status",
      status: 404,
    });

    const registry = await client.getRegistryPlugins();

    expect(registry.get("@synthetic/plugin-weather")?.gitRepo).toBe(
      "synthetic/plugin-weather",
    );
    expect(
      upstream
        .readback()
        .observations.map(({ path, status }) => ({ path, status })),
    ).toEqual([
      { path: "/generated-registry.json", status: 404 },
      { path: "/index.json", status: 200 },
    ]);
  });

  it("fails authoritative 429, malformed JSON, redirects, timeout, and cancellation", async () => {
    const cases: Array<{
      fault: RegistryMockFault;
      verify(error: unknown): void;
      timeoutMs?: number;
      abort?: boolean;
    }> = [
      {
        fault: { kind: "status", status: 429, retryAfterSeconds: 3 },
        verify: (error) => {
          expect(error).toBeInstanceOf(RegistryUpstreamError);
          expect(error).toMatchObject({ status: 429, retryAfterMs: 3_000 });
        },
      },
      {
        fault: { kind: "malformed-json" },
        verify: (error) => expect(error).toBeInstanceOf(RegistryUpstreamError),
      },
      {
        fault: { kind: "redirect" },
        verify: (error) => expect(error).toBeInstanceOf(Error),
      },
      {
        fault: { kind: "stall" },
        timeoutMs: 20,
        verify: (error) => expect(error).toBeInstanceOf(Error),
      },
      {
        fault: { kind: "stall" },
        timeoutMs: 20,
        abort: true,
        verify: (error) => expect(error).toBeInstanceOf(Error),
      },
    ];

    for (const testCase of cases) {
      const { upstream, client } = await harness({
        timeoutMs: testCase.timeoutMs,
      });
      upstream.enqueueFault("/generated-registry.json", testCase.fault);
      const controller = new AbortController();
      if (testCase.abort) controller.abort(new Error("synthetic cancellation"));
      let caught: unknown;
      try {
        await client.getRegistryPlugins({ signal: controller.signal });
      } catch (error) {
        // error-policy:J1 the test captures the public rejection for case-specific assertions.
        caught = error;
      }
      testCase.verify(caught);
      if (testCase.abort) {
        // Caller cancellation is isolated from the shared authority load. Let
        // that load reach its own bounded timeout before stopping its server.
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await runningServers.pop()?.stop();
    }
  });

  it("rejects adversarial loopback JSON before schema admission", async () => {
    let deep = "null";
    for (let depth = 0; depth <= MAX_REGISTRY_JSON_DEPTH; depth += 1) {
      deep = `[${deep}]`;
    }
    const nodeRows = Array.from({ length: MAX_REGISTRY_JSON_WIDTH }, () =>
      Array(10).fill(0),
    );
    expect(MAX_REGISTRY_JSON_WIDTH * 11).toBeGreaterThan(
      MAX_REGISTRY_JSON_NODES,
    );
    const cases: Array<{
      body: string | number[];
      contentType?: string;
      code: string;
    }> = [
      {
        body: "{}",
        contentType: "text/plain",
        code: "REGISTRY_UPSTREAM_CONTENT_TYPE_INVALID",
      },
      {
        body: [0xc3, 0x28],
        contentType: "application/json",
        code: "REGISTRY_UPSTREAM_UTF8_INVALID",
      },
      {
        body: deep,
        contentType: "application/json",
        code: "REGISTRY_UPSTREAM_JSON_LIMIT_EXCEEDED",
      },
      {
        body: JSON.stringify(Array(MAX_REGISTRY_JSON_WIDTH + 1).fill(0)),
        contentType: "application/json",
        code: "REGISTRY_UPSTREAM_JSON_LIMIT_EXCEEDED",
      },
      {
        body: JSON.stringify(nodeRows),
        contentType: "application/json",
        code: "REGISTRY_UPSTREAM_JSON_LIMIT_EXCEEDED",
      },
      {
        body: JSON.stringify("x".repeat(MAX_REGISTRY_JSON_STRING_BYTES + 1)),
        contentType: "application/json",
        code: "REGISTRY_UPSTREAM_JSON_LIMIT_EXCEEDED",
      },
      {
        body: "x".repeat(MAX_REGISTRY_JSON_BYTES + 1),
        contentType: "application/json",
        code: "REGISTRY_UPSTREAM_BODY_TOO_LARGE",
      },
    ];

    for (const testCase of cases) {
      const { upstream, client } = await harness();
      upstream.enqueueFault("/generated-registry.json", {
        kind: "raw-json-response",
        body: testCase.body,
        contentType: testCase.contentType,
      });
      await expect(client.getRegistryPlugins()).rejects.toMatchObject({
        code: testCase.code,
      });
      await runningServers.pop()?.stop();
    }
  }, 30_000);

  it("bounds success headers and cancels rejected response streams", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchRegistrySnapshot({
        generatedRegistryUrl:
          "https://registry.example/generated-registry.json",
        indexRegistryUrl: "https://registry.example/index.json",
        fetchImpl: async () =>
          new Response(body, {
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
          }),
        cloudReachable: async () => true,
        applyLocalWorkspaceApps: async () => {},
        applyNodeModulePlugins: async () => {},
        sanitizeSandbox: (value) => value ?? "allow-scripts",
      }),
    ).rejects.toMatchObject({
      code: "REGISTRY_UPSTREAM_CONTENT_ENCODING_UNSUPPORTED",
    });
    await Promise.resolve();
    expect(cancelled).toBe(true);

    for (const retryAfter of ["9".repeat(1_000), "9999999999"]) {
      let caught: unknown;
      try {
        await fetchRegistrySnapshot({
          generatedRegistryUrl:
            "https://registry.example/generated-registry.json",
          indexRegistryUrl: "https://registry.example/index.json",
          fetchImpl: async () =>
            new Response("rate limited", {
              status: 429,
              headers: { "retry-after": retryAfter },
            }),
          cloudReachable: async () => true,
          applyLocalWorkspaceApps: async () => {},
          applyNodeModulePlugins: async () => {},
          sanitizeSandbox: (value) => value ?? "allow-scripts",
        });
      } catch (error) {
        // error-policy:J1 inspect the public typed boundary below.
        caught = error;
      }
      expect(caught).toBeInstanceOf(RegistryUpstreamError);
      expect((caught as RegistryUpstreamError).retryAfterMs).toSatisfy(
        (value: number | null) =>
          value === null || value <= 24 * 60 * 60 * 1_000,
      );
    }
  });

  it("rejects corrupt cache and prevents pre-reset requests from publishing", async () => {
    const { upstream, state, client } = await harness();
    await fs.writeFile(path.join(state, "registry.json"), "{corrupt");
    expect((await client.getRegistryPlugins()).size).toBe(1);

    await client.refreshRegistry();
    upstream.enqueueFault("/generated-registry.json", {
      kind: "delay",
      ms: 50,
    });
    upstream.advanceTime(101);
    const old = client.getRegistryPlugins();
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (upstream.pendingFaultCount("/generated-registry.json") === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(upstream.pendingFaultCount("/generated-registry.json")).toBe(0);
    upstream.reset({ description: "post-reset registry" });

    await expect(old).rejects.toMatchObject({ status: 409 });
    const fresh = await client.refreshRegistry();
    expect(fresh.get("@synthetic/plugin-weather")?.description).toBe(
      "post-reset registry",
    );
    expect(upstream.readback().staleObservations).toMatchObject([
      { path: "/generated-registry.json", status: 409, stale: true },
    ]);
    const cache = JSON.parse(
      await fs.readFile(path.join(state, "registry.json"), "utf8"),
    );
    expect(cache.plugins[0][1].description).toBe("post-reset registry");
  });

  it("replays byte-equivalent state and redacts credentials in readback", async () => {
    const { upstream } = await harness();
    const run = async () => {
      const response = await fetch(upstream.generatedRegistryUrl, {
        headers: { authorization: "Bearer never-record-this" },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        digest: bytes.toString("hex"),
        observations: upstream
          .readback()
          .observations.map(({ generation: _generation, ...entry }) => entry),
      };
    };

    const first = await run();
    upstream.reset();
    const second = await run();

    expect(second).toEqual(first);
    expect(second.observations[0]?.authorization).toBe("[REDACTED]");
    expect(JSON.stringify(upstream.readback())).not.toContain(
      "never-record-this",
    );
  });
});

describe("registry artifact installation", () => {
  it("rejects an unsafe npm registry before creating an install target", async () => {
    const { state, client } = await harness();
    process.env.ELIZA_STATE_DIR = state;
    process.env.ELIZA_CONFIG_PATH = path.join(state, "eliza.json");

    const result = await installPluginWithRuntime(
      "@synthetic/plugin-weather",
      undefined,
      undefined,
      {
        getPluginInfo: client.getPluginInfo.bind(client),
        packageRegistryUrl: "http://attacker.example/npm/",
        packageManager: "npm",
      },
    );

    expect(result).toMatchObject({
      success: false,
      installPath: "",
      error: expect.stringContaining("literal loopback HTTP"),
    });
    await expect(
      fs.access(path.join(state, "plugins", "installed")),
    ).rejects.toBeDefined();
  });

  it("installs and reads the exact mock-served artifact with npm SRI provenance", async () => {
    const { upstream, state, client } = await harness();
    process.env.ELIZA_STATE_DIR = state;
    process.env.ELIZA_CONFIG_PATH = path.join(state, "eliza.json");

    const result = await installPluginWithRuntime(
      "@synthetic/plugin-weather",
      undefined,
      {
        expected: {
          packageName: "@synthetic/plugin-weather",
          version: "1.0.0",
        },
      },
      {
        getPluginInfo: client.getPluginInfo.bind(client),
        packageRegistryUrl: upstream.packageRegistryUrl,
        packageManager: "npm",
        packageManagerTimeoutMs: 5_000,
      },
    );

    expect(result).toMatchObject({
      success: true,
      version: "1.0.0",
      provenance: {
        source: "npm",
        packageName: "@synthetic/plugin-weather",
        version: "1.0.0",
        packageManager: "npm",
        resolved: expect.stringMatching(/plugin-weather-1\.0\.0\.tgz$/),
        integrity: expect.stringMatching(/^sha512-/),
      },
    });
    const installedSource = await fs.readFile(
      path.join(
        result.installPath,
        "node_modules",
        "@synthetic",
        "plugin-weather",
        "index.js",
      ),
      "utf8",
    );
    expect(installedSource).toContain(
      "Deterministic synthetic weather connector",
    );
    expect(upstream.readback().observations.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "/generated-registry.json",
        "/npm/@synthetic%2fplugin-weather",
        "/npm/@synthetic%2fplugin-weather/-/plugin-weather-1.0.0.tgz",
      ]),
    );
  }, 30_000);

  it("fails missing and integrity-mismatched artifacts without retaining an install", async () => {
    for (const mode of ["missing", "integrity", "corrupt"] as const) {
      const { upstream, state, client } = await harness();
      process.env.ELIZA_STATE_DIR = state;
      process.env.ELIZA_CONFIG_PATH = path.join(state, "eliza.json");
      const encoded = "/npm/@synthetic%2fplugin-weather";
      upstream.enqueueFault(
        mode === "missing" || mode === "corrupt"
          ? `${encoded}/-/plugin-weather-1.0.0.tgz`
          : encoded,
        mode === "missing"
          ? { kind: "status", status: 404 }
          : mode === "corrupt"
            ? { kind: "corrupt-artifact" }
            : { kind: "integrity-mismatch" },
      );
      if (mode === "corrupt") {
        upstream.enqueueFault(`${encoded}/-/plugin-weather-1.0.0.tgz`, {
          kind: "corrupt-artifact",
        });
        upstream.enqueueFault(`${encoded}/-/plugin-weather-1.0.0.tgz`, {
          kind: "corrupt-artifact",
        });
      }

      const result = await installPluginWithRuntime(
        "@synthetic/plugin-weather",
        undefined,
        undefined,
        {
          getPluginInfo: client.getPluginInfo.bind(client),
          packageRegistryUrl: upstream.packageRegistryUrl,
          packageManager: "npm",
          packageManagerTimeoutMs: 5_000,
        },
      );

      expect(result.success).toBe(false);
      await expect(fs.access(result.installPath)).rejects.toBeDefined();
      await runningServers.pop()?.stop();
    }
  }, 30_000);
});
