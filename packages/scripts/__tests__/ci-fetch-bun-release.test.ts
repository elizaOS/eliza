/**
 * Exercises Bun release selection, caching, bounded downloads, mirror fallback,
 * and local serving. Timeout coverage runs the production downloader in Node
 * against a real loopback HTTP connection; other remote-network paths use
 * deterministic fetch stubs.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateLocalBunReleaseUrl,
  waitForBunReleaseServer,
} from "../ci-await-bun-release-server.mjs";
import {
  bunReleaseUrls,
  detectLinuxAvx2,
  ensureBunReleaseZip,
  resolveBunAsset,
  serveBunZip,
  writeStoredZip,
} from "../ci-fetch-bun-release.mjs";

const BUN_VERSION = "1.3.14";

const NODE_DOWNLOAD_HARNESS = `
const spec = JSON.parse(process.env.ELIZA_BUN_TIMEOUT_TEST_SPEC);
const { readFile } = await import("node:fs/promises");
const downloader = await import(spec.moduleUrl);
const asset = downloader.resolveBunAsset(spec.host);
const [githubUrl, npmUrl] = downloader.bunReleaseUrls(spec.version, asset);
const seen = [];
const realFetch = globalThis.fetch.bind(globalThis);
const result = await downloader.ensureBunReleaseZip({
  outDir: spec.outDir,
  version: spec.version,
  host: spec.host,
  attempts: 2,
  retryDelayMs: 0,
  requestTimeoutMs: 150,
  fetchImpl: (url, init) => {
    const remoteUrl = String(url);
    seen.push(remoteUrl);
    if (remoteUrl === githubUrl) return realFetch(spec.baseUrl + "/stall", init);
    if (remoteUrl === npmUrl) return realFetch(spec.baseUrl + "/ok", init);
    throw new Error("unexpected Bun release URL: " + remoteUrl);
  },
});
const zip = await readFile(result.zipPath);
process.stdout.write(JSON.stringify({
  source: result.source,
  seen,
  zipBase64: zip.toString("base64"),
}));
`;

type NodeDownloadHarnessResult = {
  source: string;
  seen: string[];
  zipBase64: string;
};

function runNodeDownloadHarness(spec: {
  moduleUrl: string;
  baseUrl: string;
  outDir: string;
  version: string;
  host: { platform: string; arch: string; hasAvx2: boolean };
}): Promise<NodeDownloadHarnessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["--input-type=module", "--eval", NODE_DOWNLOAD_HARNESS],
      {
        env: {
          ...process.env,
          ELIZA_BUN_TIMEOUT_TEST_SPEC: JSON.stringify(spec),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 5_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (timedOut) {
        reject(new Error("Node Bun release fallback exceeded 5 seconds"));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Node Bun release harness exited with code ${String(code)} and signal ${String(signal)}: ${stderr}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        // error-policy:J2 preserve the parse failure while adding child output
        reject(
          new Error(
            `Node Bun release harness returned invalid JSON: ${stdout}`,
            {
              cause: error,
            },
          ),
        );
      }
    });
  });
}

function fakeZip() {
  const bytes = Buffer.alloc(2048, 0);
  bytes[0] = 0x50;
  bytes[1] = 0x4b;
  bytes[2] = 0x03;
  bytes[3] = 0x04;
  return bytes;
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("resolveBunAsset", () => {
  it("uses the AVX2 linux-x64 zip on GitHub-hosted class CPUs", () => {
    expect(
      resolveBunAsset({ platform: "linux", arch: "x64", hasAvx2: true }),
    ).toMatchObject({
      variant: "linux-x64",
      githubAsset: "bun-linux-x64.zip",
    });
  });

  it("falls back to the baseline linux-x64 zip without AVX2", () => {
    expect(
      resolveBunAsset({ platform: "linux", arch: "x64", hasAvx2: false }),
    ).toMatchObject({
      variant: "linux-x64-baseline",
      githubAsset: "bun-linux-x64-baseline.zip",
    });
  });

  it("maps darwin and windows hosts", () => {
    expect(
      resolveBunAsset({ platform: "darwin", arch: "arm64" }).githubAsset,
    ).toBe("bun-darwin-aarch64.zip");
    expect(
      resolveBunAsset({ platform: "win32", arch: "x64" }).githubAsset,
    ).toBe("bun-windows-x64.zip");
  });
});

describe("bunReleaseUrls", () => {
  it("pins GitHub Releases to the canonical tag and lists npm as the mirror", () => {
    const asset = resolveBunAsset({
      platform: "linux",
      arch: "x64",
      hasAvx2: true,
    });
    expect(bunReleaseUrls(BUN_VERSION, asset)).toEqual([
      `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`,
      `https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-${BUN_VERSION}.tgz`,
    ]);
  });
});

describe("detectLinuxAvx2", () => {
  it("requires a standalone avx2 flag", () => {
    expect(detectLinuxAvx2("flags : fpu avx avx2 aes")).toBe(true);
    expect(detectLinuxAvx2("flags : fpu avx aes")).toBe(false);
  });
});

describe("ensureBunReleaseZip", () => {
  it("reuses a cached zip without fetching", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "bun-zip-hit-"));
    writeFileSync(join(outDir, "bun.zip"), fakeZip());
    const calls = [];
    const result = await ensureBunReleaseZip({
      outDir,
      host: { platform: "linux", arch: "x64", hasAvx2: true },
      fetchImpl: async (url) => {
        calls.push(url);
        throw new Error("network should not run on cache hit");
      },
    });
    expect(result.cacheHit).toBe(true);
    expect(calls).toEqual([]);
  });

  it("retries GitHub then succeeds", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "bun-zip-retry-"));
    let attempts = 0;
    const result = await ensureBunReleaseZip({
      outDir,
      host: { platform: "linux", arch: "x64", hasAvx2: true },
      attempts: 3,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("socket hang up");
        }
        return {
          ok: true,
          arrayBuffer: async () => fakeZip(),
        };
      },
    });
    expect(result.cacheHit).toBe(false);
    expect(attempts).toBe(3);
    expect(result.source).toContain("github.com/oven-sh/bun/releases/download");
  });

  it("falls back to the npm mirror when GitHub stays down", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "bun-zip-npm-"));
    const seen = [];
    const result = await ensureBunReleaseZip({
      outDir,
      host: { platform: "linux", arch: "x64", hasAvx2: true },
      attempts: 1,
      fetchImpl: async (url) => {
        seen.push(String(url));
        if (String(url).includes("github.com")) {
          return {
            ok: false,
            status: 503,
            arrayBuffer: async () => Buffer.alloc(0),
          };
        }
        return { ok: true, arrayBuffer: async () => fakeZip() };
      },
    });
    expect(result.cacheHit).toBe(false);
    expect(seen[0]).toContain("github.com/oven-sh/bun/releases/download");
    expect(result.source).toContain("registry.npmjs.org/@oven/bun-linux-x64");
  });

  it("rejects invalid request deadlines before fetching", async () => {
    const invalidValues = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    let fetches = 0;
    for (const requestTimeoutMs of invalidValues) {
      const outDir = mkdtempSync(join(tmpdir(), "bun-zip-timeout-invalid-"));
      try {
        await expect(
          ensureBunReleaseZip({
            outDir,
            host: { platform: "linux", arch: "x64", hasAvx2: true },
            attempts: 1,
            requestTimeoutMs,
            fetchImpl: async () => {
              fetches += 1;
              return { ok: true, arrayBuffer: async () => fakeZip() };
            },
          }),
        ).rejects.toThrow("requestTimeoutMs must be an integer between 1 and");
      } finally {
        rmSync(outDir, { force: true, recursive: true });
      }
    }
    expect(fetches).toBe(0);
  });

  it("accepts the timer deadline boundaries", async () => {
    for (const requestTimeoutMs of [1, 2_147_483_647]) {
      const outDir = mkdtempSync(join(tmpdir(), "bun-zip-timeout-valid-"));
      let fetches = 0;
      try {
        const result = await ensureBunReleaseZip({
          outDir,
          host: { platform: "linux", arch: "x64", hasAvx2: true },
          attempts: 1,
          requestTimeoutMs,
          fetchImpl: async () => {
            fetches += 1;
            return { ok: true, arrayBuffer: async () => fakeZip() };
          },
        });
        expect(fetches).toBe(1);
        expect(result.source).toContain(
          "github.com/oven-sh/bun/releases/download",
        );
      } finally {
        rmSync(outDir, { force: true, recursive: true });
      }
    }
  });

  it("reports the final mirror and deadline after retries are exhausted", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "bun-zip-timeout-error-"));
    const asset = resolveBunAsset({
      platform: "linux",
      arch: "x64",
      hasAvx2: true,
    });
    const [, npmUrl] = bunReleaseUrls(BUN_VERSION, asset);
    const timeoutError = new Error("simulated body timeout");
    timeoutError.name = "TimeoutError";
    try {
      await expect(
        ensureBunReleaseZip({
          outDir,
          host: { platform: "linux", arch: "x64", hasAvx2: true },
          attempts: 1,
          fetchImpl: async () => {
            throw timeoutError;
          },
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          `after 1 attempt(s) with a 30000ms deadline: ${npmUrl}`,
        ),
        cause: expect.objectContaining({ name: "TimeoutError" }),
      });
    } finally {
      rmSync(outDir, { force: true, recursive: true });
    }
  });

  it("times out a stalled Node response body and advances to the npm mirror", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const stalledSockets: import("node:net").Socket[] = [];
    const stalledSocketCloses: Promise<void>[] = [];
    const serverPaths: string[] = [];
    const server = createServer((req, res) => {
      serverPaths.push(req.url ?? "");
      if (req.url === "/stall") {
        stalledSockets.push(req.socket);
        stalledSocketCloses.push(
          new Promise<void>((resolve) => req.socket.once("close", resolve)),
        );
        res.writeHead(200, {
          "content-length": String(fakeZip().length),
          "content-type": "application/zip",
        });
        res.flushHeaders();
        res.write(fakeZip().subarray(0, 64));
        return;
      }
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(fakeZip());
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const outDir = mkdtempSync(join(tmpdir(), "bun-zip-timeout-real-"));
    let listening = false;
    let downloadPromise: ReturnType<typeof runNodeDownloadHarness> | undefined;

    const operationResults = await Promise.allSettled([
      (async () => {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once("error", onError);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", onError);
            listening = true;
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("loopback test server did not bind a TCP port");
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const asset = resolveBunAsset({
          platform: "linux",
          arch: "x64",
          hasAvx2: true,
        });
        const [githubUrl, npmUrl] = bunReleaseUrls(BUN_VERSION, asset);
        downloadPromise = runNodeDownloadHarness({
          moduleUrl: new URL("../ci-fetch-bun-release.mjs", import.meta.url)
            .href,
          baseUrl,
          outDir,
          version: BUN_VERSION,
          host: { platform: "linux", arch: "x64", hasAvx2: true },
        });
        const result = await downloadPromise;

        expect(stalledSocketCloses).toHaveLength(2);
        await withDeadline(
          Promise.all(stalledSocketCloses),
          2_000,
          "stalled sockets did not close after request aborts",
        );

        expect(result.seen).toEqual([githubUrl, githubUrl, npmUrl]);
        expect(serverPaths).toEqual(["/stall", "/stall", "/ok"]);
        expect(stalledSockets.every((socket) => socket.destroyed)).toBe(true);
        expect(result.source).toBe(npmUrl);
        expect(Buffer.from(result.zipBase64, "base64")).toEqual(fakeZip());
      })(),
    ]);

    const teardownChecks: Promise<unknown>[] = [];
    if (listening) {
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      for (const socket of sockets) socket.destroy();
      teardownChecks.push(
        withDeadline(
          serverClosed,
          2_000,
          "loopback server did not close during teardown",
        ),
      );
    }
    if (downloadPromise) {
      teardownChecks.push(
        withDeadline(
          Promise.allSettled([downloadPromise]),
          2_000,
          "Node Bun release download did not settle during teardown",
        ),
      );
    }
    const teardownResults = await Promise.allSettled(teardownChecks);
    const remainingSockets = sockets.size;
    for (const socket of sockets) socket.destroy();
    rmSync(outDir, { force: true, recursive: true });

    for (const result of [...operationResults, ...teardownResults]) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(remainingSockets).toBe(0);
  });

  it("converts an npm tarball into a GitHub-layout zip without the zip CLI", async () => {
    const staging = mkdtempSync(join(tmpdir(), "bun-npm-src-"));
    mkdirSync(join(staging, "package"), { recursive: true });
    const bunName = process.platform === "win32" ? "bun.exe" : "bun";
    writeFileSync(join(staging, "package", bunName), Buffer.alloc(2048, 0x61));
    const tgzPath = join(staging, "bun.tgz");
    execFileSync("tar", ["-czf", tgzPath, "-C", staging, "package"]);
    const tgz = readFileSync(tgzPath);
    expect(tgz[0]).toBe(0x1f);
    expect(tgz[1]).toBe(0x8b);

    const outDir = mkdtempSync(join(tmpdir(), "bun-zip-tgz-"));
    const result = await ensureBunReleaseZip({
      outDir,
      host: { platform: "linux", arch: "x64", hasAvx2: true },
      attempts: 1,
      fetchImpl: async (url) => {
        if (String(url).includes("github.com")) {
          return {
            ok: false,
            status: 503,
            arrayBuffer: async () => Buffer.alloc(0),
          };
        }
        return { ok: true, arrayBuffer: async () => tgz };
      },
    });
    expect(result.source).toContain("registry.npmjs.org/@oven/bun-linux-x64");
    const zip = readFileSync(result.zipPath);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip.includes(Buffer.from(`bun-linux-x64/${bunName}`))).toBe(true);
  });
});

describe("writeStoredZip", () => {
  it("writes a PK zip that contains the GitHub release path", () => {
    const outDir = mkdtempSync(join(tmpdir(), "bun-stored-zip-"));
    const zipPath = join(outDir, "bun.zip");
    writeStoredZip(zipPath, [
      {
        name: "bun-linux-x64/bun",
        data: Buffer.alloc(2048, 0x62),
        executable: true,
      },
    ]);
    const zip = readFileSync(zipPath);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip.includes(Buffer.from("bun-linux-x64/bun"))).toBe(true);
  });
});

describe("serveBunZip", () => {
  it("serves the cached zip on localhost", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "bun-zip-serve-"));
    const zipPath = join(outDir, "bun.zip");
    writeFileSync(zipPath, fakeZip());
    const { url, server } = await serveBunZip(zipPath);
    try {
      const response = await fetch(url);
      expect(response.ok).toBe(true);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});

describe("waitForBunReleaseServer", () => {
  it("allows a loaded runner to publish readiness after multiple polls", async () => {
    let polls = 0;
    const url = await waitForBunReleaseServer(
      {
        pid: 42,
        urlFile: "/tmp/bun-url",
        timeoutMs: 30_000,
        pollIntervalMs: 100,
      },
      {
        exists: () => polls >= 75,
        read: () => "http://127.0.0.1:12345/bun.zip\n",
        isAlive: () => true,
        now: () => polls * 100,
        sleep: async () => {
          polls += 1;
        },
      },
    );
    expect(polls).toBe(75);
    expect(url).toBe("http://127.0.0.1:12345/bun.zip");
  });

  it("fails immediately when the detached server exits", async () => {
    let slept = false;
    await expect(
      waitForBunReleaseServer(
        { pid: 42, urlFile: "/tmp/bun-url", timeoutMs: 30_000 },
        {
          exists: () => false,
          isAlive: () => false,
          now: () => 0,
          sleep: async () => {
            slept = true;
          },
        },
      ),
    ).rejects.toThrow("exited before publishing");
    expect(slept).toBe(false);
  });

  it("times out deterministically and rejects non-loopback URLs", async () => {
    let elapsedMs = 0;
    await expect(
      waitForBunReleaseServer(
        {
          pid: 42,
          urlFile: "/tmp/bun-url",
          timeoutMs: 250,
          pollIntervalMs: 100,
        },
        {
          exists: () => false,
          isAlive: () => true,
          now: () => elapsedMs,
          sleep: async (durationMs) => {
            elapsedMs += durationMs;
          },
        },
      ),
    ).rejects.toThrow("within 250ms");
    expect(() =>
      validateLocalBunReleaseUrl("https://example.com/bun.zip"),
    ).toThrow("invalid loopback URL");
  });

  it("pins both composite actions to the bounded diagnostic helper", () => {
    for (const actionPath of [
      ".github/actions/setup-bun-workspace/action.yml",
      ".github/actions/cloud-setup-test-env/action.yml",
    ]) {
      const action = readFileSync(actionPath, "utf8");
      expect(action).toContain(
        "node packages/scripts/ci-await-bun-release-server.mjs",
      );
      expect(action).toContain('--pid "$server_pid"');
      expect(action).toContain("--timeout-ms 60000");
      expect(action).toContain("Bun zip server diagnostics");
      expect(action).not.toContain('while [ "$i" -lt 50 ]');
    }
  });
});
