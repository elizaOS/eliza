import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    BinaryResolver,
    type YtDlpRunner,
    ytDlpAssetName,
    ytDlpFileName,
} from "./binaries.js";

const ytMock = vi.fn();

vi.mock("youtube-dl-exec", () => {
    const callable = (...args: unknown[]) => ytMock(...args);
    (callable as unknown as { create: (p: string) => YtDlpRunner }).create = (
        _p: string,
    ) => callable as unknown as YtDlpRunner;
    return {
        default: callable,
        create: (_p: string) => callable,
    };
});

describe("BinaryResolver", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "binres-test-"));
        delete process.env.MILADY_YT_DLP_PATH;
        delete process.env.MILADY_YT_DLP_PREFER_PATH;
        delete process.env.MILADY_FFMPEG_PATH;
        delete process.env.MILADY_DISABLE_YTDLP_AUTOUPDATE;
    });

    afterEach(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
        ytMock.mockReset();
        BinaryResolver.resetForTests();
        delete process.env.MILADY_YT_DLP_PATH;
        delete process.env.MILADY_YT_DLP_PREFER_PATH;
        delete process.env.MILADY_FFMPEG_PATH;
        delete process.env.MILADY_DISABLE_YTDLP_AUTOUPDATE;
    });

    async function writeExecutable(
        filePath: string,
        content = "fake-binary",
    ): Promise<string> {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, content);
        await fsp.chmod(filePath, 0o755);
        return filePath;
    }

    interface FetchHandler {
        match: (url: string) => boolean;
        respond: () => Response;
    }

    function buildFetch(handlers: FetchHandler[]): typeof fetch {
        return (async (input: string | URL | Request, _init?: RequestInit) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.toString()
                      : input.url;
            const handler = handlers.find((h) => h.match(url));
            if (!handler) throw new Error(`Unexpected fetch: ${url}`);
            return handler.respond();
        }) as unknown as typeof fetch;
    }

    function buildRelease(
        binaryContent: string,
        binaryUrl = "https://example.invalid/yt-dlp-asset",
        sumsUrl = "https://example.invalid/SHA2-256SUMS",
    ): {
        release: object;
        binaryUrl: string;
        sumsUrl: string;
        sha: string;
    } {
        const sha = createHash("sha256").update(binaryContent).digest("hex");
        const release = {
            tag_name: "2026.04.30",
            assets: [
                {
                    name: ytDlpAssetName(),
                    browser_download_url: binaryUrl,
                    size: binaryContent.length,
                },
                {
                    name: "SHA2-256SUMS",
                    browser_download_url: sumsUrl,
                    size: 0,
                },
            ],
        };
        return { release, binaryUrl, sumsUrl, sha };
    }

    function buildHandlers(
        releaseUrl: string,
        binary: { binaryContent: string; binaryUrl: string; sumsUrl: string; sha: string; release: object },
    ): FetchHandler[] {
        return [
            {
                match: (u) => u === releaseUrl,
                respond: () =>
                    new Response(JSON.stringify(binary.release), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
            },
            {
                match: (u) => u === binary.sumsUrl,
                respond: () =>
                    new Response(
                        `${binary.sha}  ${ytDlpAssetName()}\n0000000000000000000000000000000000000000000000000000000000000000  some-other-asset\n`,
                        { status: 200 },
                    ),
            },
            {
                match: (u) => u === binary.binaryUrl,
                respond: () =>
                    new Response(binary.binaryContent, { status: 200 }),
            },
        ];
    }

    describe("resolution", () => {
        it("uses MILADY_YT_DLP_PATH env override when executable", async () => {
            const envPath = await writeExecutable(path.join(tmpDir, "custom-yt-dlp"));
            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: envPath,
            });
            const resolved = await r.getYtDlpPath();
            expect(resolved).toBe(envPath);
        });

        it("falls through when env override is not executable", async () => {
            const envPath = path.join(tmpDir, "missing-bin");
            const cachePath = await writeExecutable(
                path.join(tmpDir, "cache", ytDlpFileName()),
            );
            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: envPath,
            });
            const resolved = await r.getYtDlpPath();
            expect(resolved).toBe(cachePath);
        });

        it("prefers managed cache over PATH by default", async () => {
            const cachePath = await writeExecutable(
                path.join(tmpDir, "cache", ytDlpFileName()),
            );
            const sysDir = await fsp.mkdtemp(
                path.join(os.tmpdir(), "binres-sys-"),
            );
            const sysBin = await writeExecutable(
                path.join(sysDir, ytDlpFileName()),
            );
            const oldPath = process.env.PATH;
            process.env.PATH = `${sysDir}${path.delimiter}${oldPath ?? ""}`;
            try {
                const r = new BinaryResolver({
                    binariesDir: path.join(tmpDir, "cache"),
                    envOverridePath: null,
                });
                const resolved = await r.getYtDlpPath();
                expect(resolved).toBe(cachePath);
                expect(resolved).not.toBe(sysBin);
            } finally {
                process.env.PATH = oldPath;
                await fsp.rm(sysDir, { recursive: true, force: true });
            }
        });

        it("prefers PATH over cache when MILADY_YT_DLP_PREFER_PATH is set", async () => {
            await writeExecutable(path.join(tmpDir, "cache", ytDlpFileName()));
            const sysDir = await fsp.mkdtemp(
                path.join(os.tmpdir(), "binres-sys-"),
            );
            const sysBin = await writeExecutable(
                path.join(sysDir, ytDlpFileName()),
            );
            const oldPath = process.env.PATH;
            process.env.PATH = `${sysDir}${path.delimiter}${oldPath ?? ""}`;
            try {
                const r = new BinaryResolver({
                    binariesDir: path.join(tmpDir, "cache"),
                    envOverridePath: null,
                    preferSystemPath: true,
                });
                const resolved = await r.getYtDlpPath();
                expect(resolved).toBe(sysBin);
            } finally {
                process.env.PATH = oldPath;
                await fsp.rm(sysDir, { recursive: true, force: true });
            }
        });

        it("falls back to PATH when cache empty and prefer-path is off", async () => {
            const sysDir = await fsp.mkdtemp(
                path.join(os.tmpdir(), "binres-sys-"),
            );
            const sysBin = await writeExecutable(
                path.join(sysDir, ytDlpFileName()),
            );
            const oldPath = process.env.PATH;
            process.env.PATH = `${sysDir}${path.delimiter}${oldPath ?? ""}`;
            try {
                const r = new BinaryResolver({
                    binariesDir: path.join(tmpDir, "cache"),
                    envOverridePath: null,
                });
                const resolved = await r.getYtDlpPath();
                expect(resolved).toBe(sysBin);
            } finally {
                process.env.PATH = oldPath;
                await fsp.rm(sysDir, { recursive: true, force: true });
            }
        });

        it("downloads to cache when nothing else is available", async () => {
            const binary = "fake-binary-content-v2026";
            const release = buildRelease(binary);
            const releaseUrl = "https://example.invalid/release";
            const cacheDir = path.join(tmpDir, "cache");

            const oldPath = process.env.PATH;
            process.env.PATH = "/nonexistent-dir-for-test";
            try {
                const r = new BinaryResolver({
                    binariesDir: cacheDir,
                    envOverridePath: null,
                    releaseUrl,
                    fetchImpl: buildFetch(
                        buildHandlers(releaseUrl, { ...release, binaryContent: binary }),
                    ),
                });
                const resolved = await r.getYtDlpPath();
                expect(resolved).toBe(path.join(cacheDir, ytDlpFileName()));
                const stat = await fsp.stat(resolved);
                expect(stat.isFile()).toBe(true);
                expect(stat.mode & 0o111).not.toBe(0);
                const content = await fsp.readFile(resolved, "utf8");
                expect(content).toBe(binary);
                const meta = JSON.parse(
                    await fsp.readFile(path.join(cacheDir, "yt-dlp.meta.json"), "utf8"),
                );
                expect(meta.version).toBe("2026.04.30");
                expect(meta.sha256).toBe(release.sha);
            } finally {
                process.env.PATH = oldPath;
            }
        });

        it("rejects download with mismatched sha256", async () => {
            const binary = "fake-binary";
            const release = buildRelease(binary);
            const releaseUrl = "https://example.invalid/release";
            const handlers = buildHandlers(releaseUrl, {
                ...release,
                binaryContent: binary,
            });
            const sumsHandler = handlers.find((h) =>
                h.match(release.sumsUrl),
            );
            if (!sumsHandler) throw new Error("test setup: no sums handler");
            sumsHandler.respond = () =>
                new Response(
                    `0000000000000000000000000000000000000000000000000000000000000000  ${ytDlpAssetName()}\n`,
                    { status: 200 },
                );

            const oldPath = process.env.PATH;
            process.env.PATH = "/nonexistent-dir-for-test";
            try {
                const r = new BinaryResolver({
                    binariesDir: path.join(tmpDir, "cache"),
                    envOverridePath: null,
                    releaseUrl,
                    fetchImpl: buildFetch(handlers),
                });
                await expect(r.getYtDlpPath()).rejects.toThrow(/SHA256 mismatch/);
                const cachedPath = path.join(
                    tmpDir,
                    "cache",
                    ytDlpFileName(),
                );
                await expect(fsp.stat(cachedPath)).rejects.toBeDefined();
            } finally {
                process.env.PATH = oldPath;
            }
        });
    });

    describe("auto-update on extractor failure", () => {
        it("triggers update + retry when cache binary fails with extractor pattern", async () => {
            const oldBinary = await writeExecutable(
                path.join(tmpDir, "cache", ytDlpFileName()),
                "old-binary",
            );
            const newContent = "new-binary-content-v2";
            const release = buildRelease(newContent);
            const releaseUrl = "https://example.invalid/release";

            ytMock
                .mockRejectedValueOnce(
                    Object.assign(new Error("yt-dlp failed"), {
                        stderr:
                            "ERROR: [youtube] dQw4w9WgXcQ: Unable to extract sig; please report this issue",
                    }),
                )
                .mockResolvedValueOnce({ title: "ok-second-call" });

            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: null,
                releaseUrl,
                fetchImpl: buildFetch(
                    buildHandlers(releaseUrl, { ...release, binaryContent: newContent }),
                ),
                now: () => 1_000_000,
                updateThrottleMs: 60 * 60 * 1000,
            });

            const result = (await r.runYtDlp("https://example.com/video", {})) as {
                title: string;
            };
            expect(result.title).toBe("ok-second-call");
            expect(ytMock).toHaveBeenCalledTimes(2);

            const refreshed = await fsp.readFile(oldBinary, "utf8");
            expect(refreshed).toBe(newContent);
        });

        it("does not retry on non-extractor errors", async () => {
            await writeExecutable(
                path.join(tmpDir, "cache", ytDlpFileName()),
                "binary",
            );
            ytMock.mockRejectedValueOnce(
                Object.assign(new Error("yt-dlp failed"), {
                    stderr:
                        "ERROR: [generic] Unable to download webpage: HTTPSConnectionPool",
                }),
            );

            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: null,
                releaseUrl: "https://example.invalid/release",
                fetchImpl: buildFetch([]),
            });

            await expect(r.runYtDlp("https://example.com/v", {})).rejects.toThrow();
            expect(ytMock).toHaveBeenCalledTimes(1);
        });

        it("does not auto-update when source is env override", async () => {
            const envBin = await writeExecutable(path.join(tmpDir, "env-bin"));
            ytMock.mockRejectedValueOnce(
                Object.assign(new Error("fail"), {
                    stderr: "Unable to extract player response",
                }),
            );
            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: envBin,
                releaseUrl: "https://example.invalid/release",
                fetchImpl: buildFetch([]),
            });
            await expect(r.runYtDlp("https://x.test/v", {})).rejects.toThrow();
            expect(ytMock).toHaveBeenCalledTimes(1);
        });

        it("does not auto-update when MILADY_DISABLE_YTDLP_AUTOUPDATE=1", async () => {
            await writeExecutable(
                path.join(tmpDir, "cache", ytDlpFileName()),
            );
            ytMock.mockRejectedValueOnce(
                Object.assign(new Error("fail"), {
                    stderr: "Unable to extract sig",
                }),
            );
            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: null,
                disableAutoUpdate: true,
                releaseUrl: "https://example.invalid/release",
                fetchImpl: buildFetch([]),
            });
            await expect(r.runYtDlp("https://x.test/v", {})).rejects.toThrow();
            expect(ytMock).toHaveBeenCalledTimes(1);
        });

        it("throttles repeated update attempts within the throttle window", async () => {
            await writeExecutable(
                path.join(tmpDir, "cache", ytDlpFileName()),
                "old",
            );
            const newContent = "new-binary-throttle";
            const release = buildRelease(newContent);
            const releaseUrl = "https://example.invalid/release";
            let nowVal = 1_000_000;

            // First failure → update succeeds. Second failure shortly after → throttled, no update.
            ytMock
                .mockRejectedValueOnce(
                    Object.assign(new Error("e1"), {
                        stderr: "Unable to extract foo",
                    }),
                )
                .mockResolvedValueOnce({ ok: 1 })
                .mockRejectedValueOnce(
                    Object.assign(new Error("e2"), {
                        stderr: "Unable to extract bar",
                    }),
                );

            const handlers = buildHandlers(releaseUrl, {
                ...release,
                binaryContent: newContent,
            });
            const fetchSpy = vi.fn(buildFetch(handlers));

            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: null,
                releaseUrl,
                fetchImpl: fetchSpy as unknown as typeof fetch,
                now: () => nowVal,
                updateThrottleMs: 60 * 60 * 1000,
            });

            await r.runYtDlp("https://x/1", {});
            const firstFetchCount = fetchSpy.mock.calls.length;
            expect(firstFetchCount).toBeGreaterThan(0);

            // Same nowVal — within throttle window. Second failure must NOT re-fetch from GitHub.
            await expect(r.runYtDlp("https://x/2", {})).rejects.toThrow("e2");
            expect(fetchSpy.mock.calls.length).toBe(firstFetchCount);
        });
    });

    describe("ffmpeg resolution", () => {
        it("uses MILADY_FFMPEG_PATH env override when executable", async () => {
            const ffPath = await writeExecutable(path.join(tmpDir, "ffmpeg"));
            process.env.MILADY_FFMPEG_PATH = ffPath;
            const r = new BinaryResolver({
                binariesDir: path.join(tmpDir, "cache"),
                envOverridePath: null,
            });
            expect(await r.getFfmpegPath()).toBe(ffPath);
        });
    });

    describe("asset selection", () => {
        it("returns a non-empty asset name for the current platform", () => {
            const name = ytDlpAssetName();
            expect(name.length).toBeGreaterThan(0);
            if (process.platform === "darwin") expect(name).toBe("yt-dlp_macos");
            if (process.platform === "win32")
                expect(name === "yt-dlp.exe" || name === "yt-dlp_x86.exe").toBe(true);
            if (process.platform === "linux")
                expect(name.startsWith("yt-dlp_linux")).toBe(true);
        });
    });
});
