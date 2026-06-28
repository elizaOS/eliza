/**
 * Real packaging verification for the eliza-1 wake-word GGUFs (issue #9880).
 *
 * Downloads every registered hey-eliza GGUF from HuggingFace at the catalog's
 * pinned revision and asserts the published bytes match the catalog exactly:
 * sha256, size, and the GGUF magic header. This is the guard that the eliza-1
 * wake-word packaging is intact and correctly registered — it fails loudly if a
 * re-publish drifts the bytes or the catalog records a stale hash.
 *
 * Network-bound, so it lives in the `*.real.test.ts` post-merge lane (skipped in
 * the default PR lane). Run: `TEST_LANE=post-merge bun run --cwd packages/shared test`.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { latestVoiceModelVersion, voiceModelAssetUrl } from "./voice-models.js";

const GGUF_MAGIC = "GGUF";

describe("eliza-1 wake-word GGUF packaging — real download", () => {
  const wake = latestVoiceModelVersion("wakeword");

  it("every registered GGUF matches its catalog sha256 + size + GGUF magic", async () => {
    if (!wake) throw new Error("wakeword version missing");
    const assets = wake.ggufAssets;
    expect(assets.length).toBe(3);

    for (const asset of assets) {
      const url = voiceModelAssetUrl(wake, asset);
      const res = await fetch(url);
      expect(res.ok, `${asset.filename} → HTTP ${res.status}`).toBe(true);
      const bytes = new Uint8Array(await res.arrayBuffer());

      // GGUF magic header.
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe(GGUF_MAGIC);
      // Size pinned in the catalog.
      expect(bytes.byteLength).toBe(asset.sizeBytes);
      // Content hash pinned in the catalog.
      const sha = createHash("sha256").update(bytes).digest("hex");
      expect(sha, `${asset.filename} sha256 drift`).toBe(asset.sha256);
    }
  }, 120_000);
});
