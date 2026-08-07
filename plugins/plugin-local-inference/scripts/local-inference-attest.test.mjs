/**
 * Verifies byte, host, backend, executable, and positive-execution attestation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attest } from "./local-inference-attest.mjs";

const platformTest = process.platform === "win32" ? test.skip : test;

platformTest(
  "attests exact bytes and rejects mismatched or empty evidence",
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "local-inference-attest-"),
    );
    try {
      const binary = path.join(root, "llama-server");
      const model = path.join(root, "model.gguf");
      const report = path.join(root, "report.json");
      const out = path.join(root, "attestation.json");
      fs.symlinkSync(process.execPath, binary);
      fs.writeFileSync(model, "model-bytes");
      fs.writeFileSync(
        report,
        JSON.stringify({
          hardware: {
            platform: process.platform,
            arch: process.arch,
            backend: "cpu",
          },
          variants: [{ name: "baseline", ok: true, runs: [{ tokPerSec: 1 }] }],
        }),
      );
      const expected = createHash("sha256").update("model-bytes").digest("hex");
      const args = {
        binary,
        model,
        report,
        backend: "cpu",
        "expected-model-sha256": expected,
        "source-sha": "a".repeat(40),
        "workflow-sha": "b".repeat(40),
        out,
      };
      const manifest = await attest(args);
      assert.equal(manifest.model.sha256, expected);
      assert.equal(manifest.report.executedVariants, 1);
      assert.equal(
        JSON.parse(fs.readFileSync(out, "utf8")).binary.version,
        process.version,
      );
      await assert.rejects(
        attest({ ...args, "expected-model-sha256": "0".repeat(64) }),
        /model SHA-256 mismatch/,
      );
      fs.writeFileSync(
        report,
        JSON.stringify({
          hardware: {
            platform: process.platform,
            arch: process.arch,
            backend: "cpu",
          },
          variants: [],
        }),
      );
      await assert.rejects(attest(args), /zero successful variants/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
