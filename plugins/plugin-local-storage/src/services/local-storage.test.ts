/**
 * Unit tests for `LocalFileStorageService`: storage-root precedence,
 * upload/download/exists/delete, key normalization, and signed-URL
 * generation. Runs real filesystem I/O against temp directories; only the
 * `IAgentRuntime` is stubbed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileStorageService } from "./local-storage";

function runtime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getService: vi.fn(),
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

describe("LocalFileStorageService", () => {
  let root: string;
  let sourceDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "eliza-local-storage-root-"));
    sourceDir = mkdtempSync(path.join(tmpdir(), "eliza-local-storage-source-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
    delete process.env.LOCAL_STORAGE_PATH;
  });

  it("prefers runtime storage root over environment root", async () => {
    process.env.LOCAL_STORAGE_PATH = mkdtempSync(path.join(tmpdir(), "eliza-local-storage-env-"));
    const service = await LocalFileStorageService.start(runtime({ LOCAL_STORAGE_PATH: root }));

    expect(service.root).toBe(path.resolve(root));
    await service.stop();
    rmSync(process.env.LOCAL_STORAGE_PATH, { recursive: true, force: true });
  });

  it("uploads bytes, returns file URLs, downloads buffers, checks existence, and deletes", async () => {
    const service = await LocalFileStorageService.start(runtime({ LOCAL_STORAGE_PATH: root }));

    const result = await service.uploadBytes(
      Uint8Array.from([1, 2, 3]),
      "sample.bin",
      "application/octet-stream",
      "nested//dir"
    );

    // The URL format is platform-aware: POSIX uses two slashes
    // (`file:///abs/path`), Windows uses three plus drive letter
    // (`file:///C:/abs/path`). `pathToFileURL` produces the right shape on
    // either host, which is what the service now returns.
    const { pathToFileURL } = await import("node:url");
    expect(result).toEqual({
      success: true,
      url: pathToFileURL(path.join(root, "nested/dir/sample.bin")).href,
    });
    await expect(service.exists("ignored", "nested/dir/sample.bin")).resolves.toBe(true);
    await expect(service.downloadBytes("ignored", "nested/dir/sample.bin")).resolves.toEqual(
      Buffer.from([1, 2, 3])
    );

    await service.delete("ignored", "nested/dir/sample.bin");
    await expect(service.exists("ignored", "nested/dir/sample.bin")).resolves.toBe(false);
  });

  it("uploads files using a timestamped basename and can download them to a local path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const service = await LocalFileStorageService.start(runtime({ LOCAL_STORAGE_PATH: root }));
    const source = path.join(sourceDir, "input.txt");
    const destination = path.join(sourceDir, "output.txt");
    writeFileSync(source, "hello");

    const result = await service.uploadFile(source, "uploads");

    const { pathToFileURL: toUrl1 } = await import("node:url");
    expect(result.url).toBe(toUrl1(path.join(root, "uploads/1767323045000-input.txt")).href);
    await service.downloadFile("ignored", "uploads/1767323045000-input.txt", destination);
    expect(readFileSync(destination, "utf8")).toBe("hello");
    vi.useRealTimers();
  });

  it("uploads pretty JSON and rejects missing JSON data", async () => {
    const service = await LocalFileStorageService.start(runtime({ LOCAL_STORAGE_PATH: root }));

    const { pathToFileURL: toUrl2 } = await import("node:url");
    await expect(service.uploadJson({ ok: true }, "data.json", "json")).resolves.toEqual({
      success: true,
      key: "json/data.json",
      url: toUrl2(path.join(root, "json/data.json")).href,
    });
    expect(readFileSync(path.join(root, "json/data.json"), "utf8")).toBe(
      JSON.stringify({ ok: true }, null, 2)
    );
    await expect(service.uploadJson(null as unknown as Record<string, never>)).resolves.toEqual({
      success: false,
      error: "JSON data is required",
    });
  });

  it("rejects path traversal and absolute storage keys", async () => {
    const service = await LocalFileStorageService.start(runtime({ LOCAL_STORAGE_PATH: root }));

    await expect(
      service.uploadBytes(Buffer.from("x"), "../escape.txt", "text/plain")
    ).rejects.toThrow("Invalid local storage key");
    await expect(service.uploadJson({ ok: true }, "data.json", "../../escape")).rejects.toThrow(
      "Invalid local storage key"
    );
    await expect(service.downloadBytes("ignored", "/absolute.txt")).rejects.toThrow(
      "Invalid local storage key"
    );
    await expect(service.generateSignedUrl("nested/../../escape.txt")).rejects.toThrow(
      "Invalid local storage key"
    );
    await expect(service.generateSignedUrl("nested/../escape.txt")).rejects.toThrow(
      "Invalid local storage key"
    );
    await expect(service.generateSignedUrl(String.raw`nested\..\escape.txt`)).rejects.toThrow(
      "Invalid local storage key"
    );
    await expect(service.generateSignedUrl("./escape.txt")).rejects.toThrow(
      "Invalid local storage key"
    );
  });

  it("throws after stop instead of silently operating on a disposed service", async () => {
    const service = await LocalFileStorageService.start(runtime({ LOCAL_STORAGE_PATH: root }));

    await service.stop();

    await expect(service.exists("ignored", "file.txt")).rejects.toThrow(
      "LocalFileStorageService not initialized"
    );
  });
});
