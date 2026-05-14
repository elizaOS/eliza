// Smoke tests for the Kokoro additions in cmake-graft.mjs.
//
// Validates the surface added by the KOKORO-TTS-PORT phase-2 work:
//   - `hasKokoroSourcesInTree` returns false when the fork submodule
//      has no `kokoro-*.cpp` files staged under `omnivoice/src/`.
//   - `fusedExtraCmakeFlags()` adds `-DELIZA_FUSE_KOKORO=ON` only when
//      Kokoro sources are present; the legacy omnivoice + shared-libs
//      flags are unconditional.
//   - `hasKokoroCmakeGraft` is idempotent against the sentinel.
//   - `appendKokoroCmakeGraft` writes the snippet on a clean tree and
//      no-ops on re-run.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  KOKORO_CMAKE_GRAFT_SENTINEL,
  appendKokoroCmakeGraft,
  fusedExtraCmakeFlags,
  hasKokoroCmakeGraft,
  hasKokoroSourcesInTree,
} from "./cmake-graft.mjs";

describe("hasKokoroSourcesInTree", () => {
  it("returns false for a non-existent fork root", () => {
    expect(
      hasKokoroSourcesInTree("/definitely/not/here/" + Date.now()),
    ).toBe(false);
  });

  it("returns false for a fork root without omnivoice/src", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-test-"));
    try {
      expect(hasKokoroSourcesInTree(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false when omnivoice/src exists but has no kokoro-*.cpp", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-test-"));
    try {
      fs.mkdirSync(path.join(root, "omnivoice", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "omnivoice", "src", "omnivoice.cpp"),
        "",
      );
      expect(hasKokoroSourcesInTree(root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns true when omnivoice/src/kokoro-*.cpp exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-test-"));
    try {
      fs.mkdirSync(path.join(root, "omnivoice", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "omnivoice", "src", "kokoro-engine.cpp"),
        "// stub",
      );
      expect(hasKokoroSourcesInTree(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fusedExtraCmakeFlags", () => {
  // Run inside a temp cwd so the helper's default-fork-root probe lands
  // somewhere predictable.
  let origCwd;
  let tmpCwd;
  beforeEach(() => {
    origCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fused-cwd-"));
    process.chdir(tmpCwd);
  });
  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("returns omnivoice + shared-libs flags by default", () => {
    const flags = fusedExtraCmakeFlags();
    expect(flags).toEqual([
      "-DELIZA_FUSE_OMNIVOICE=ON",
      "-DBUILD_SHARED_LIBS=ON",
    ]);
  });

  it("appends -DELIZA_FUSE_KOKORO=ON when sources are staged", () => {
    fs.mkdirSync(
      path.join(
        tmpCwd,
        "plugins",
        "plugin-local-inference",
        "native",
        "llama.cpp",
        "omnivoice",
        "src",
      ),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        tmpCwd,
        "plugins",
        "plugin-local-inference",
        "native",
        "llama.cpp",
        "omnivoice",
        "src",
        "kokoro-engine.cpp",
      ),
      "// stub",
    );
    const flags = fusedExtraCmakeFlags();
    expect(flags).toContain("-DELIZA_FUSE_OMNIVOICE=ON");
    expect(flags).toContain("-DBUILD_SHARED_LIBS=ON");
    expect(flags).toContain("-DELIZA_FUSE_KOKORO=ON");
  });
});

describe("hasKokoroCmakeGraft", () => {
  it("returns false on an empty CMakeLists.txt", () => {
    expect(hasKokoroCmakeGraft("")).toBe(false);
  });

  it("returns false when only the OmniVoice sentinel is present", () => {
    expect(hasKokoroCmakeGraft("# ELIZA-OMNIVOICE-FUSION-GRAFT-V1")).toBe(
      false,
    );
  });

  it("returns true when the Kokoro sentinel is present", () => {
    expect(hasKokoroCmakeGraft(`prelude\n${KOKORO_CMAKE_GRAFT_SENTINEL}\n`)).toBe(
      true,
    );
  });
});

describe("appendKokoroCmakeGraft", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-graft-test-"));
    // Seed with a minimal CMakeLists.txt; the test only cares about
    // append semantics, not the existing content.
    fs.writeFileSync(
      path.join(root, "CMakeLists.txt"),
      "# placeholder llama.cpp CMakeLists.txt\n",
    );
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("appends the Kokoro snippet on a clean tree", () => {
    const written = appendKokoroCmakeGraft({ llamaCppRoot: root });
    expect(written).toBe(true);
    const after = fs.readFileSync(path.join(root, "CMakeLists.txt"), "utf8");
    expect(after).toContain(KOKORO_CMAKE_GRAFT_SENTINEL);
    expect(after).toContain("if(ELIZA_FUSE_KOKORO)");
    expect(after).toContain("target_sources(omnivoice-core PRIVATE");
    expect(after).toContain("convert_kokoro_to_gguf.py");
  });

  it("is idempotent on re-run (sentinel guard)", () => {
    const first = appendKokoroCmakeGraft({ llamaCppRoot: root });
    expect(first).toBe(true);
    const sizeAfterFirst = fs.statSync(
      path.join(root, "CMakeLists.txt"),
    ).size;
    const second = appendKokoroCmakeGraft({ llamaCppRoot: root });
    expect(second).toBe(false);
    const sizeAfterSecond = fs.statSync(
      path.join(root, "CMakeLists.txt"),
    ).size;
    expect(sizeAfterSecond).toBe(sizeAfterFirst);
  });

  it("rejects missing llamaCppRoot", () => {
    expect(() => appendKokoroCmakeGraft({})).toThrow(/llamaCppRoot is required/);
  });
});
