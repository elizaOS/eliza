import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the deleted `omnivoice-fuse` legacy graft path
 * (issue #12216, fix C16).
 *
 * The pre-merge OmniVoice graft (`omnivoice-fuse/prepare.mjs`) was the
 * `OMNIVOICE_INSIDE_LLAMA_CPP=0` back-compat runway. Per native/AGENTS.md §1 it
 * is deleted after the v1.0.2-eliza release; the active build path is
 * `build-helpers/omnivoice-merged.mjs`. This test asserts the directory does
 * not regrow — a re-added `omnivoice-fuse/` means someone resurrected the dead
 * graft path instead of using the merged build.
 */
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

describe("omnivoice-fuse legacy graft path removal (C16)", () => {
  it("does not have an omnivoice-fuse directory", () => {
    const graftDir = path.join(scriptsDir, "omnivoice-fuse");
    expect(fs.existsSync(graftDir)).toBe(false);
  });

  it("keeps the merged build helper as the live path", () => {
    const merged = path.join(
      scriptsDir,
      "build-helpers",
      "omnivoice-merged.mjs",
    );
    expect(fs.existsSync(merged)).toBe(true);
  });
});
