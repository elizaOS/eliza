/**
 * Unit tests for bundled fused-library discovery. findBundledFusedLibDir walks
 * up from the runtime module URL to a sibling local-inference/lib that holds the
 * platform fused binary, and ensureBundledFusedLibDir points
 * ELIZA_INFERENCE_LIB_DIR at it while respecting explicit
 * ELIZA_INFERENCE_LIB_DIR / ELIZA_INFERENCE_LIBRARY overrides. Runs against real
 * temp dirs staged on disk (no mocks); both return null in dev/mobile layouts
 * where nothing is bundled.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureBundledFusedLibDir,
  findBundledFusedLibDir,
  fusedLibraryFilenames,
} from "./bundled-fused-lib";

let root: string;

/** Build `<root>/<...segs>/runtime/module.js` and return its file:// URL. */
function moduleUrlAt(...segs: string[]): string {
  const dir = path.join(root, ...segs, "runtime");
  mkdirSync(dir, { recursive: true });
  return pathToFileURL(path.join(dir, "eliza.js")).href;
}

/** Stage a platform fused lib under `<root>/<...segs>/local-inference/lib`. */
function stageLibAt(...segs: string[]): string {
  const libDir = path.join(root, ...segs, "local-inference", "lib");
  mkdirSync(libDir, { recursive: true });
  writeFileSync(path.join(libDir, fusedLibraryFilenames()[0]), "stub");
  return libDir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fused-lib-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findBundledFusedLibDir", () => {
  it("finds a sibling local-inference/lib that holds the fused lib", () => {
    const libDir = stageLibAt("app");
    // module nested deep, mirroring eliza-dist/node_modules/@elizaos/app-core/dist/runtime
    const url = moduleUrlAt(
      "app",
      "node_modules",
      "@elizaos",
      "app-core",
      "dist",
    );
    expect(findBundledFusedLibDir(url)).toBe(libDir);
  });

  it("returns null when nothing is staged (dev / mobile)", () => {
    const url = moduleUrlAt("app", "dist");
    expect(findBundledFusedLibDir(url)).toBeNull();
  });

  it("does not match a local-inference/lib that lacks the fused lib", () => {
    // Empty lib dir present but no fused binary in it.
    mkdirSync(path.join(root, "app", "local-inference", "lib"), {
      recursive: true,
    });
    const url = moduleUrlAt("app", "dist");
    expect(findBundledFusedLibDir(url)).toBeNull();
  });
});

describe("ensureBundledFusedLibDir", () => {
  it("sets ELIZA_INFERENCE_LIB_DIR to the bundled dir when present", () => {
    const libDir = stageLibAt("app");
    const url = moduleUrlAt("app", "dist");
    const env: NodeJS.ProcessEnv = {};
    expect(ensureBundledFusedLibDir(env, url)).toBe(libDir);
    expect(env.ELIZA_INFERENCE_LIB_DIR).toBe(libDir);
  });

  it("respects an explicit ELIZA_INFERENCE_LIB_DIR override", () => {
    stageLibAt("app");
    const url = moduleUrlAt("app", "dist");
    const env: NodeJS.ProcessEnv = { ELIZA_INFERENCE_LIB_DIR: "/custom/lib" };
    expect(ensureBundledFusedLibDir(env, url)).toBe("/custom/lib");
    expect(env.ELIZA_INFERENCE_LIB_DIR).toBe("/custom/lib");
  });

  it("respects an explicit ELIZA_INFERENCE_LIBRARY override", () => {
    stageLibAt("app");
    const url = moduleUrlAt("app", "dist");
    const libFile = path.join("/custom", "lib", fusedLibraryFilenames()[0]);
    const env: NodeJS.ProcessEnv = { ELIZA_INFERENCE_LIBRARY: libFile };
    expect(ensureBundledFusedLibDir(env, url)).toBe(path.dirname(libFile));
    // Must not overwrite the explicit library override with a lib dir.
    expect(env.ELIZA_INFERENCE_LIB_DIR).toBeUndefined();
  });

  it("is a no-op (returns null) when nothing is bundled", () => {
    const url = moduleUrlAt("app", "dist");
    const env: NodeJS.ProcessEnv = {};
    expect(ensureBundledFusedLibDir(env, url)).toBeNull();
    expect(env.ELIZA_INFERENCE_LIB_DIR).toBeUndefined();
  });
});
