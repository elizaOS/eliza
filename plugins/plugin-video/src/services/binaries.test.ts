/**
 * Binary resolver unit coverage for platform-neutral helper logic. The real
 * downloader and ffmpeg probes are covered by the opt-in integration test so
 * the default suite stays deterministic.
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BinaryResolver,
  ffmpegStaticExecutableName,
  resolveFfmpegStaticCandidatePath,
  resolveNodeInstallRunner,
  ytDlpAssetName,
  ytDlpFileName,
} from "./binaries";

const originalEnv = {
  PATH: process.env.PATH,
  ELIZA_FFMPEG_PATH: process.env.ELIZA_FFMPEG_PATH,
  ELIZA_YT_DLP_PATH: process.env.ELIZA_YT_DLP_PATH,
};

let tempRoots: string[] = [];

beforeEach(() => {
  BinaryResolver.resetForTests();
  process.env.PATH = originalEnv.PATH;
  process.env.ELIZA_FFMPEG_PATH = originalEnv.ELIZA_FFMPEG_PATH;
  process.env.ELIZA_YT_DLP_PATH = originalEnv.ELIZA_YT_DLP_PATH;
});

afterEach(async () => {
  BinaryResolver.resetForTests();
  process.env.PATH = originalEnv.PATH;
  process.env.ELIZA_FFMPEG_PATH = originalEnv.ELIZA_FFMPEG_PATH;
  process.env.ELIZA_YT_DLP_PATH = originalEnv.ELIZA_YT_DLP_PATH;
  await Promise.all(
    tempRoots.map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
  tempRoots = [];
});

async function makeTempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "plugin-video-binaries-"));
  tempRoots.push(root);
  return root;
}

async function writeExecutable(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, "#!/bin/sh\nexit 0\n");
  await fsp.chmod(filePath, 0o755);
}

describe("resolveNodeInstallRunner", () => {
  it("keeps the current executable when already running under Node", () => {
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "/opt/node/bin/node",
      }),
    ).toBe("/opt/node/bin/node");
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "C:\\Program Files\\nodejs\\node.exe",
      }),
    ).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("uses node from PATH when invoked under Bun", () => {
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("node");
  });

  it("honors an explicit Node binary override", () => {
    expect(
      resolveNodeInstallRunner({
        env: { ELIZA_NODE_BIN: "/custom/node" },
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("/custom/node");
    expect(
      resolveNodeInstallRunner({
        env: { NODE_BINARY: "/toolchain/node" },
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("/toolchain/node");
  });
});

describe("BinaryResolver ffmpeg resolution", () => {
  it("uses ELIZA_FFMPEG_PATH before probing PATH", async () => {
    const root = await makeTempRoot();
    const ffmpeg = path.join(root, "custom-ffmpeg");
    await writeExecutable(ffmpeg);
    process.env.ELIZA_FFMPEG_PATH = ffmpeg;
    process.env.PATH = "";

    const resolver = new BinaryResolver({ binariesDir: root });

    await expect(resolver.getFfmpegPath()).resolves.toBe(ffmpeg);
    await fsp.chmod(ffmpeg, 0o644);
    await expect(resolver.getFfmpegPath()).resolves.toBe(ffmpeg);
  });

  it("falls back to ffmpeg on PATH when no env override is configured", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, "bin");
    const ffmpeg = path.join(binDir, "ffmpeg");
    await writeExecutable(ffmpeg);
    delete process.env.ELIZA_FFMPEG_PATH;
    process.env.PATH = binDir;

    const resolver = new BinaryResolver({ binariesDir: root });

    await expect(resolver.getFfmpegPath()).resolves.toBe(ffmpeg);
  });
});

describe("BinaryResolver yt-dlp resolution", () => {
  it("uses an executable ELIZA_YT_DLP_PATH override", async () => {
    const root = await makeTempRoot();
    const ytDlp = path.join(root, "custom-yt-dlp");
    await writeExecutable(ytDlp);
    process.env.ELIZA_YT_DLP_PATH = ytDlp;

    const resolver = new BinaryResolver({
      binariesDir: path.join(root, "cache"),
    });

    await expect(resolver.getYtDlpPath()).resolves.toBe(ytDlp);
  });

  it("uses system yt-dlp first when preferSystemPath is enabled", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, "bin");
    const ytDlp = path.join(binDir, ytDlpFileName());
    await writeExecutable(ytDlp);
    delete process.env.ELIZA_YT_DLP_PATH;
    process.env.PATH = binDir;

    const resolver = new BinaryResolver({
      binariesDir: path.join(root, "cache"),
      preferSystemPath: true,
    });

    await expect(resolver.getYtDlpPath()).resolves.toBe(ytDlp);
  });

  it("uses the managed cache before PATH by default", async () => {
    const root = await makeTempRoot();
    const cacheDir = path.join(root, "cache");
    const cached = path.join(cacheDir, ytDlpFileName());
    const binDir = path.join(root, "bin");
    await writeExecutable(cached);
    await writeExecutable(path.join(binDir, ytDlpFileName()));
    delete process.env.ELIZA_YT_DLP_PATH;
    process.env.PATH = binDir;

    const resolver = new BinaryResolver({ binariesDir: cacheDir });

    await expect(resolver.getYtDlpPath()).resolves.toBe(cached);
  });

  it("uses PATH when the managed cache is empty", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, "bin");
    const ytDlp = path.join(binDir, ytDlpFileName());
    await writeExecutable(ytDlp);
    delete process.env.ELIZA_YT_DLP_PATH;
    process.env.PATH = binDir;

    const resolver = new BinaryResolver({
      binariesDir: path.join(root, "cache"),
    });

    await expect(resolver.getYtDlpPath()).resolves.toBe(ytDlp);
  });

  it("creates a yt-dlp runner from the resolved binary path", async () => {
    const root = await makeTempRoot();
    const ytDlp = path.join(root, "custom-yt-dlp");
    await writeExecutable(ytDlp);
    process.env.ELIZA_YT_DLP_PATH = ytDlp;

    const resolver = new BinaryResolver({
      binariesDir: path.join(root, "cache"),
    });

    await expect(resolver.getYtDlpRunner()).resolves.toEqual(
      expect.any(Function),
    );
  });

  it("downloads yt-dlp, verifies SHA256, and writes metadata", async () => {
    const root = await makeTempRoot();
    const cacheDir = path.join(root, "cache");
    const assetName = ytDlpAssetName();
    const binary = "fake yt-dlp binary\n";
    const sha = createHash("sha256").update(binary).digest("hex");
    const fetches: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      fetches.push(url);
      if (url === "https://example.test/latest") {
        return new Response(
          JSON.stringify({
            tag_name: "2026.07.09",
            assets: [
              {
                name: assetName,
                browser_download_url: "https://example.test/bin",
                size: binary.length,
              },
              {
                name: "SHA2-256SUMS",
                browser_download_url: "https://example.test/sums",
                size: 120,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "https://example.test/sums") {
        return new Response(`${sha}  ${assetName}\n`, { status: 200 });
      }
      if (url === "https://example.test/bin") {
        return new Response(binary, { status: 200 });
      }
      return new Response("not found", {
        status: 404,
        statusText: "Not Found",
      });
    };

    const resolver = new BinaryResolver({
      binariesDir: cacheDir,
      releaseUrl: "https://example.test/latest",
      fetchImpl,
      now: () => 1_789_000_000_000,
    });

    await expect(resolver.downloadYtDlp()).resolves.toMatchObject({
      version: "2026.07.09",
      sha256: sha,
      assetName,
      downloadedAt: 1_789_000_000_000,
      lastUpdateAttemptedAt: 1_789_000_000_000,
    });
    await expect(fsp.readFile(resolver.cachedYtDlpPath, "utf8")).resolves.toBe(
      binary,
    );
    await expect(fsp.readFile(resolver.metaPath, "utf8")).resolves.toContain(
      "2026.07.09",
    );
    expect(fetches).toEqual([
      "https://example.test/latest",
      "https://example.test/sums",
      "https://example.test/bin",
    ]);
  });

  it("reports malformed release metadata before downloading", async () => {
    const root = await makeTempRoot();
    const resolver = new BinaryResolver({
      binariesDir: path.join(root, "cache"),
      releaseUrl: "https://example.test/latest",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            tag_name: "2026.07.09",
            assets: [],
          }),
          { status: 200 },
        ),
    });

    await expect(resolver.downloadYtDlp()).rejects.toThrow(
      "has no asset named",
    );
  });

  it("reports missing checksum metadata before downloading", async () => {
    const root = await makeTempRoot();
    const resolver = new BinaryResolver({
      binariesDir: path.join(root, "cache"),
      releaseUrl: "https://example.test/latest",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            tag_name: "2026.07.09",
            assets: [
              {
                name: ytDlpAssetName(),
                browser_download_url: "https://example.test/bin",
                size: 1,
              },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(resolver.downloadYtDlp()).rejects.toThrow(
      "has no SHA2-256SUMS asset",
    );
  });

  it("rejects failed release, checksum, and binary fetches", async () => {
    const root = await makeTempRoot();
    const releaseFailure = new BinaryResolver({
      binariesDir: path.join(root, "release-failure"),
      releaseUrl: "https://example.test/latest",
      fetchImpl: async () =>
        new Response("nope", { status: 503, statusText: "Unavailable" }),
    });
    await expect(releaseFailure.downloadYtDlp()).rejects.toThrow(
      "release fetch failed: 503 Unavailable",
    );

    const checksumFailure = new BinaryResolver({
      binariesDir: path.join(root, "checksum-failure"),
      releaseUrl: "https://example.test/latest",
      fetchImpl: async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/sums")) {
          return new Response("nope", {
            status: 500,
            statusText: "Broken",
          });
        }
        return new Response(
          JSON.stringify({
            tag_name: "2026.07.09",
            assets: [
              {
                name: ytDlpAssetName(),
                browser_download_url: "https://example.test/bin",
                size: 1,
              },
              {
                name: "SHA2-256SUMS",
                browser_download_url: "https://example.test/sums",
                size: 1,
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    await expect(checksumFailure.downloadYtDlp()).rejects.toThrow(
      "SHA2-256SUMS fetch failed: 500 Broken",
    );

    const binaryFailure = new BinaryResolver({
      binariesDir: path.join(root, "binary-failure"),
      releaseUrl: "https://example.test/latest",
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/sums")) {
          return new Response(`${"0".repeat(64)}  ${ytDlpAssetName()}\n`, {
            status: 200,
          });
        }
        if (url.endsWith("/bin")) {
          return new Response("nope", {
            status: 404,
            statusText: "Missing",
          });
        }
        return new Response(
          JSON.stringify({
            tag_name: "2026.07.09",
            assets: [
              {
                name: ytDlpAssetName(),
                browser_download_url: "https://example.test/bin",
                size: 1,
              },
              {
                name: "SHA2-256SUMS",
                browser_download_url: "https://example.test/sums",
                size: 1,
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    await expect(binaryFailure.downloadYtDlp()).rejects.toThrow(
      "binary fetch failed: 404 Missing",
    );
  });

  it("rejects checksum files without a matching asset entry", async () => {
    const root = await makeTempRoot();
    const resolver = new BinaryResolver({
      binariesDir: path.join(root, "cache"),
      releaseUrl: "https://example.test/latest",
      fetchImpl: async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/sums")) {
          return new Response(`${"0".repeat(64)}  another-file\n`, {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            tag_name: "2026.07.09",
            assets: [
              {
                name: ytDlpAssetName(),
                browser_download_url: "https://example.test/bin",
                size: 1,
              },
              {
                name: "SHA2-256SUMS",
                browser_download_url: "https://example.test/sums",
                size: 1,
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(resolver.downloadYtDlp()).rejects.toThrow(
      "SHA2-256SUMS missing entry",
    );
  });

  it("deletes the temp binary when checksum validation fails", async () => {
    const root = await makeTempRoot();
    const cacheDir = path.join(root, "cache");
    const resolver = new BinaryResolver({
      binariesDir: cacheDir,
      releaseUrl: "https://example.test/latest",
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/sums")) {
          return new Response(`${"0".repeat(64)}  ${ytDlpAssetName()}\n`, {
            status: 200,
          });
        }
        if (url.endsWith("/bin")) {
          return new Response("not the expected content", { status: 200 });
        }
        return new Response(
          JSON.stringify({
            tag_name: "2026.07.09",
            assets: [
              {
                name: ytDlpAssetName(),
                browser_download_url: "https://example.test/bin",
                size: 24,
              },
              {
                name: "SHA2-256SUMS",
                browser_download_url: "https://example.test/sums",
                size: 1,
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(resolver.downloadYtDlp()).rejects.toThrow(
      "yt-dlp SHA256 mismatch",
    );
    await expect(fsp.readdir(cacheDir)).resolves.toEqual([]);
  });
});

describe("resolveFfmpegStaticCandidatePath", () => {
  it("uses the package-local ffmpeg binary path on Unix-like platforms", () => {
    expect(
      resolveFfmpegStaticCandidatePath({
        packageRoot: "/repo/node_modules/ffmpeg-static",
        platform: "linux",
      }),
    ).toBe("/repo/node_modules/ffmpeg-static/ffmpeg");
    expect(ffmpegStaticExecutableName("darwin")).toBe("ffmpeg");
  });

  it("uses the package-local ffmpeg.exe path on Windows", () => {
    expect(
      resolveFfmpegStaticCandidatePath({
        packageRoot: "C:\\repo\\node_modules\\ffmpeg-static",
        platform: "win32",
      }),
    ).toBe("C:\\repo\\node_modules\\ffmpeg-static\\ffmpeg.exe");
    expect(ffmpegStaticExecutableName("win32")).toBe("ffmpeg.exe");
  });

  it("returns null when ffmpeg-static is not installed", () => {
    expect(resolveFfmpegStaticCandidatePath({ packageRoot: null })).toBeNull();
  });
});
