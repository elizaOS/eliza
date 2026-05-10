import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dflashEnabled,
  getDflashRuntimeStatus,
  parseDflashMetrics,
  resolveDflashBinary,
} from "./dflash-server";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeManagedBinary(root: string): string {
  const backend = process.platform === "darwin" ? "metal" : "cpu";
  const managed = path.join(
    root,
    "local-inference",
    "bin",
    "dflash",
    `${process.platform}-${process.arch}-${backend}`,
    "llama-server",
  );
  fs.mkdirSync(path.dirname(managed), { recursive: true });
  fs.writeFileSync(managed, "#!/bin/sh\n", "utf8");
  fs.chmodSync(managed, 0o755);
  return managed;
}

describe("DFlash runtime discovery", () => {
  it("auto-enables when the managed binary exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dflash-test-"));
    process.env.ELIZA_STATE_DIR = root;
    delete process.env.ELIZA_DFLASH_ENABLED;
    delete process.env.ELIZA_DFLASH_DISABLED;
    delete process.env.ELIZA_DFLASH_METAL_AUTO;
    delete process.env.ELIZA_DFLASH_METAL_ENABLED;
    delete process.env.HIP_VISIBLE_DEVICES;
    delete process.env.ROCR_VISIBLE_DEVICES;
    delete process.env.CUDA_VISIBLE_DEVICES;
    const binary = makeManagedBinary(root);
    const isMetalRuntime = process.platform === "darwin";

    expect(resolveDflashBinary()).toBe(binary);
    expect(dflashEnabled()).toBe(!isMetalRuntime);
    expect(getDflashRuntimeStatus().enabled).toBe(!isMetalRuntime);

    if (isMetalRuntime) {
      expect(getDflashRuntimeStatus().reason).toContain("auto-disabled");
      process.env.ELIZA_DFLASH_METAL_AUTO = "1";
      expect(dflashEnabled()).toBe(true);
      expect(getDflashRuntimeStatus().enabled).toBe(true);
    }
  });

  it("does not use PATH llama-server unless explicitly enabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dflash-test-"));
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "llama-server"), "#!/bin/sh\n", "utf8");
    fs.chmodSync(path.join(binDir, "llama-server"), 0o755);
    process.env.ELIZA_STATE_DIR = root;
    process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ""}`;
    delete process.env.ELIZA_DFLASH_ENABLED;
    delete process.env.HIP_VISIBLE_DEVICES;
    delete process.env.ROCR_VISIBLE_DEVICES;
    delete process.env.CUDA_VISIBLE_DEVICES;

    expect(dflashEnabled()).toBe(false);
    expect(resolveDflashBinary()).toBe(null);

    process.env.ELIZA_DFLASH_ENABLED = "1";
    expect(resolveDflashBinary()).toBe(path.join(binDir, "llama-server"));
  });
});

describe("parseDflashMetrics", () => {
  it("parses Prometheus counters with label sets and _total suffix", () => {
    const text = `# HELP llamacpp:n_decode_total Number of tokens decoded by the model.
# TYPE llamacpp:n_decode_total counter
llamacpp:n_decode_total 128
# HELP llamacpp:n_drafted_total Number of tokens drafted.
# TYPE llamacpp:n_drafted_total counter
llamacpp:n_drafted_total 200
# HELP llamacpp:n_drafted_accepted_total Number of drafted tokens accepted.
# TYPE llamacpp:n_drafted_accepted_total counter
llamacpp:n_drafted_accepted_total{slot_id="0"} 130
`;
    const snapshot = parseDflashMetrics(text);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.decoded).toBe(128);
    expect(snapshot!.drafted).toBe(200);
    expect(snapshot!.accepted).toBe(130);
    expect(snapshot!.acceptanceRate).toBeCloseTo(0.65, 5);
  });

  it("falls back to non-_total counter names emitted by older fork builds", () => {
    const text = `llamacpp:n_decode 64
llamacpp:n_drafted 100
llamacpp:n_drafted_accepted 75
`;
    const snapshot = parseDflashMetrics(text);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.decoded).toBe(64);
    expect(snapshot!.drafted).toBe(100);
    expect(snapshot!.accepted).toBe(75);
    expect(snapshot!.acceptanceRate).toBeCloseTo(0.75, 5);
  });

  it("returns null when the response has no speculative counters", () => {
    const text = `# HELP some_other_metric Random gauge.
# TYPE some_other_metric gauge
some_other_metric 1.0
`;
    expect(parseDflashMetrics(text)).toBeNull();
  });

  it("reports NaN acceptance when drafter has not produced any tokens", () => {
    const text = `llamacpp:n_decode_total 16
llamacpp:n_drafted_total 0
llamacpp:n_drafted_accepted_total 0
`;
    const snapshot = parseDflashMetrics(text);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.drafted).toBe(0);
    expect(Number.isNaN(snapshot!.acceptanceRate)).toBe(true);
  });
});
