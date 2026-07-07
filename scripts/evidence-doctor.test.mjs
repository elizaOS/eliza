/**
 * Tests for the evidence-toolchain doctor. `runProbes` shells out to real
 * binaries, so these assert the shape and classification invariants (every
 * probe carries a fix, required-missing drives strict failure) rather than the
 * presence of any given tool, which varies by host.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProbes, summarize } from "./evidence-doctor.mjs";

describe("evidence-doctor", () => {
  it("returns a probe for every capability with a pasteable fix", async () => {
    const probes = await runProbes({});
    const ids = probes.map((p) => p.id);
    for (const id of [
      "tesseract",
      "ffmpeg",
      "playwright-browsers",
      "gpu-vision-ocr",
      "apple-vision-ocr",
      "vlm-vision-qa-api",
      "coding-agent-cli",
    ]) {
      assert.ok(ids.includes(id), `missing probe: ${id}`);
    }
    for (const probe of probes) {
      assert.equal(typeof probe.ok, "boolean");
      assert.equal(typeof probe.required, "boolean");
      assert.ok(probe.fix.length > 0, `${probe.id} lacks a fix`);
    }
  });

  it("keys strict failure on required-missing only", () => {
    const optionalOnly = summarize([
      { id: "a", required: true, ok: true, fix: "x" },
      { id: "b", required: false, ok: false, fix: "x" },
    ]);
    assert.equal(optionalOnly.ok, true);
    assert.equal(optionalOnly.optionalMissing.length, 1);

    const requiredGap = summarize([
      { id: "a", required: true, ok: false, fix: "x" },
    ]);
    assert.equal(requiredGap.ok, false);
    assert.equal(requiredGap.requiredMissing.length, 1);
  });

  it("detects an API vision backend from env", async () => {
    const probes = await runProbes({ ANTHROPIC_API_KEY: "sk-test" });
    const api = probes.find((p) => p.id === "vlm-vision-qa-api");
    assert.equal(api.ok, true);
  });
});
