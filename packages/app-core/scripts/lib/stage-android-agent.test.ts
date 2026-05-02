import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageSeccompShimForAbi } from "./stage-android-agent.mjs";

describe("stageSeccompShimForAbi", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stage-android-shim-test-"),
    );
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  function setUpAlpineLoader(abiAssetsDir: string, ldName: string) {
    fs.mkdirSync(abiAssetsDir, { recursive: true });
    // Alpine loader is ~600 KB. Pad the fixture above the 200 KB
    // discriminator threshold the staging logic uses to tell wrappers
    // and real loaders apart.
    const stub = Buffer.alloc(300 * 1024, 0x55);
    fs.writeFileSync(path.join(abiAssetsDir, ldName), stub);
  }

  function writeCachedShimAndWrap(
    cacheDir: string,
    androidAbi: string,
    ldName: string,
  ) {
    const abiCacheDir = path.join(cacheDir, androidAbi);
    fs.mkdirSync(abiCacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(abiCacheDir, "libsigsys-handler.so"),
      "ELF-shim",
      "utf8",
    );
    fs.writeFileSync(path.join(abiCacheDir, ldName), "ELF-wrap", "utf8");
  }

  it("no-ops on arm64-v8a (no shim is built or staged for that ABI)", () => {
    const abiAssetsDir = path.join(scratchDir, "assets", "arm64-v8a");
    setUpAlpineLoader(abiAssetsDir, "ld-musl-aarch64.so.1");
    // Even if cache artifacts exist, arm64 must short-circuit — the
    // shim source is x86_64-only and using its assembly conventions
    // on arm64 would produce a non-functional handler.
    writeCachedShimAndWrap(scratchDir, "arm64-v8a", "ld-musl-aarch64.so.1");
    const changes = stageSeccompShimForAbi({
      androidAbi: "arm64-v8a",
      ldName: "ld-musl-aarch64.so.1",
      abiAssetsDir,
      cacheDir: scratchDir,
    });
    expect(changes).toBe(0);
    // Original Alpine loader is left in place untouched.
    expect(
      fs.existsSync(
        path.join(abiAssetsDir, "ld-musl-aarch64.so.1"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(abiAssetsDir, "ld-musl-aarch64.so.1.real"),
      ),
    ).toBe(false);
  });

  it("no-ops when the cache has no compiled shim for x86_64", () => {
    const abiAssetsDir = path.join(scratchDir, "assets", "x86_64");
    setUpAlpineLoader(abiAssetsDir, "ld-musl-x86_64.so.1");
    const changes = stageSeccompShimForAbi({
      androidAbi: "x86_64",
      ldName: "ld-musl-x86_64.so.1",
      abiAssetsDir,
      cacheDir: scratchDir,
    });
    expect(changes).toBe(0);
    // Loader stays at the canonical name (no rename).
    expect(
      fs.existsSync(path.join(abiAssetsDir, "ld-musl-x86_64.so.1")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(abiAssetsDir, "ld-musl-x86_64.so.1.real")),
    ).toBe(false);
  });

  it("relocates the Alpine loader to .real and stages wrapper + shim", () => {
    const abiAssetsDir = path.join(scratchDir, "assets", "x86_64");
    setUpAlpineLoader(abiAssetsDir, "ld-musl-x86_64.so.1");
    writeCachedShimAndWrap(scratchDir, "x86_64", "ld-musl-x86_64.so.1");
    const changes = stageSeccompShimForAbi({
      androidAbi: "x86_64",
      ldName: "ld-musl-x86_64.so.1",
      abiAssetsDir,
      cacheDir: scratchDir,
    });
    expect(changes).toBeGreaterThan(0);
    // Real loader moved to .real
    expect(
      fs.existsSync(path.join(abiAssetsDir, "ld-musl-x86_64.so.1.real")),
    ).toBe(true);
    expect(
      fs.statSync(path.join(abiAssetsDir, "ld-musl-x86_64.so.1.real")).size,
    ).toBeGreaterThan(200 * 1024);
    // Wrapper installed at the canonical name (small file from cache)
    expect(
      fs.readFileSync(
        path.join(abiAssetsDir, "ld-musl-x86_64.so.1"),
        "utf8",
      ),
    ).toBe("ELF-wrap");
    // Shim staged alongside.
    expect(
      fs.readFileSync(
        path.join(abiAssetsDir, "libsigsys-handler.so"),
        "utf8",
      ),
    ).toBe("ELF-shim");
  });

  it("is idempotent — re-running on an already-wrapped tree refreshes nothing", () => {
    const abiAssetsDir = path.join(scratchDir, "assets", "x86_64");
    setUpAlpineLoader(abiAssetsDir, "ld-musl-x86_64.so.1");
    writeCachedShimAndWrap(scratchDir, "x86_64", "ld-musl-x86_64.so.1");
    stageSeccompShimForAbi({
      androidAbi: "x86_64",
      ldName: "ld-musl-x86_64.so.1",
      abiAssetsDir,
      cacheDir: scratchDir,
    });
    const second = stageSeccompShimForAbi({
      androidAbi: "x86_64",
      ldName: "ld-musl-x86_64.so.1",
      abiAssetsDir,
      cacheDir: scratchDir,
    });
    expect(second).toBe(0);
  });

  it("refuses to install the wrapper without a corresponding .real loader", () => {
    // Edge case: the wrapper is already in place but the .real loader
    // was removed (e.g. cache wipe + rebuild). Installing the wrapper
    // without a .real to chain to would silently break the spawn at
    // runtime — the shim staging step must surface that explicitly.
    const abiAssetsDir = path.join(scratchDir, "assets", "x86_64");
    fs.mkdirSync(abiAssetsDir, { recursive: true });
    // Tiny "wrapper-already-in-place" stub (under the 200 KB threshold).
    fs.writeFileSync(
      path.join(abiAssetsDir, "ld-musl-x86_64.so.1"),
      "ELF-stale-wrap",
      "utf8",
    );
    writeCachedShimAndWrap(scratchDir, "x86_64", "ld-musl-x86_64.so.1");
    expect(() =>
      stageSeccompShimForAbi({
        androidAbi: "x86_64",
        ldName: "ld-musl-x86_64.so.1",
        abiAssetsDir,
        cacheDir: scratchDir,
      }),
    ).toThrow(/missing.*re-run stageAndroidAgentRuntime/i);
  });
});
