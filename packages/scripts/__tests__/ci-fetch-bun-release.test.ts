/**
 * Exercises Bun release URL selection, AVX2 variant choice, GitHub-to-npm
 * fallback, and zip cache hits. Network is a deterministic fetch stub.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function fakeZip() {
  const bytes = Buffer.alloc(2048, 0);
  bytes[0] = 0x50;
  bytes[1] = 0x4b;
  bytes[2] = 0x03;
  bytes[3] = 0x04;
  return bytes;
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

  it("converts an npm tarball into a GitHub-layout zip without the zip CLI", async () => {
    const staging = mkdtempSync(join(tmpdir(), "bun-npm-src-"));
    mkdirSync(join(staging, "package"), { recursive: true });
    writeFileSync(join(staging, "package", "bun"), Buffer.alloc(2048, 0x61));
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
    expect(zip.includes(Buffer.from("bun-linux-x64/bun"))).toBe(true);
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
