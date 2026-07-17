import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  INVENTORY_PATH,
  assembleManifest,
  validateInventory,
  validateManifest,
} from "./cuda-continuity.mjs";

const HEAD = "a".repeat(40);
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuda-continuity-"));
  dirs.push(dir);
  const files = {
    probe: path.join(dir, "probe.json"),
    report: path.join(dir, "report.json"),
    capabilities: path.join(dir, "CAPABILITIES.json"),
    log: path.join(dir, "native.log"),
    output: path.join(dir, "manifest.json"),
  };
  const probe = overrides.probe || {
    schemaVersion: 1,
    status: "pass",
    exactHead: true,
    head: HEAD,
    expectedHead: HEAD,
    nativeSourceCommit: "d".repeat(40),
    workflowRun: { id: "123", attempt: "1", event: "workflow_dispatch" },
    cuda: { toolkitVersion: "12.8", driverRuntimeVersion: "13.0" },
    devices: [
      {
        name: "NVIDIA GeForce RTX 5090",
        computeCapability: "12.0",
        driverVersion: "580.1",
        memoryMiB: 32768,
      },
    ],
  };
  const report = overrides.report || {
    schemaVersion: 1,
    status: "pass",
    passRecordable: true,
    target: "linux-x64-cuda",
    requirements: { graphSmoke: "required" },
    evidence: { modelSha256: "b".repeat(64) },
  };
  const capabilities = overrides.capabilities || {
    target: "linux-x64-cuda",
    forkCommit: "d".repeat(40),
    builtAt: "2026-07-17T09:00:00.000Z",
    publishable: true,
    missingRequiredKernels: [],
    kernels: {
      turbo3: true,
      turbo4: true,
      turbo3_tcq: true,
      qjl_full: true,
      polarquant: true,
      mtp: true,
    },
  };
  fs.writeFileSync(files.probe, JSON.stringify(probe));
  fs.writeFileSync(files.report, JSON.stringify(report));
  fs.writeFileSync(files.capabilities, JSON.stringify(capabilities));
  fs.writeFileSync(
    files.log,
    overrides.log ||
      "CUDA fixtures 8/8 PASS\nruntime graph CUDA generation PASS\n",
  );
  return files;
}

function assemble(files) {
  return assembleManifest({
    probePath: files.probe,
    reportPath: files.report,
    capabilitiesPath: files.capabilities,
    logPath: files.log,
    outputPath: files.output,
    expectedHead: HEAD,
  });
}

describe("CUDA continuity inventory", () => {
  it("pins every retired context and supported architecture", () => {
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
    assert.equal(
      validateInventory(inventory, {
        root: path.resolve(import.meta.dirname, ".."),
      }),
      true,
    );
  });

  it("rejects matrix drift", () => {
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
    inventory.supportedMatrix = inventory.supportedMatrix.filter(
      (entry) => entry.id !== "h200-sm90",
    );
    assert.throws(
      () =>
        validateInventory(inventory, {
          root: path.resolve(import.meta.dirname, ".."),
        }),
      /h200-sm90/,
    );
  });
});

describe("CUDA exact-head manifest", () => {
  it("assembles a complete fail-closed manifest", () => {
    const manifest = assemble(fixture());
    assert.equal(validateManifest(manifest, { expectedHead: HEAD }), true);
    assert.deepEqual(
      manifest.artifacts.map((entry) => entry.id),
      ["cuda-probe", "cuda-report", "capabilities", "native-log"],
    );
  });

  it("rejects a missing GPU instead of producing a false green", () => {
    const files = fixture();
    const probe = JSON.parse(fs.readFileSync(files.probe, "utf8"));
    probe.devices = [];
    fs.writeFileSync(files.probe, JSON.stringify(probe));
    assert.throws(() => assemble(files), /no GPU device inventory/);
  });

  it("rejects skipped graph smoke and partial native verification", () => {
    const files = fixture({
      report: {
        status: "pass",
        passRecordable: false,
        target: "linux-x64-cuda",
        requirements: { graphSmoke: "skipped" },
        evidence: {},
      },
    });
    assert.throws(() => assemble(files), /recordable pass|graph smoke/);
  });

  it("rejects missing kernels or a non-publishable build", () => {
    const files = fixture({
      capabilities: {
        target: "linux-x64-cuda",
        forkCommit: "d".repeat(40),
        builtAt: "2026-07-17T09:00:00.000Z",
        publishable: false,
        missingRequiredKernels: ["mtp"],
        kernels: { mtp: false },
      },
    });
    assert.throws(() => assemble(files), /not publishable/);
  });

  it("rejects a graph smoke report without its model hash", () => {
    const files = fixture({
      report: {
        status: "pass",
        passRecordable: true,
        target: "linux-x64-cuda",
        requirements: { graphSmoke: "required" },
        evidence: {},
      },
    });
    assert.throws(() => assemble(files), /graph smoke SHA-256/);
  });

  it("rejects a capability manifest that omits required kernel claims", () => {
    const files = fixture();
    const capabilities = JSON.parse(
      fs.readFileSync(files.capabilities, "utf8"),
    );
    capabilities.kernels = {};
    fs.writeFileSync(files.capabilities, JSON.stringify(capabilities));
    assert.throws(() => assemble(files), /missing kernels:.*turbo3/);
  });

  it("rejects a prebuilt binary from a different native source revision", () => {
    const files = fixture();
    const capabilities = JSON.parse(
      fs.readFileSync(files.capabilities, "utf8"),
    );
    capabilities.forkCommit = "e".repeat(40);
    fs.writeFileSync(files.capabilities, JSON.stringify(capabilities));
    assert.throws(() => assemble(files), /does not match.*native source/i);
  });

  it("rejects CPU fallback, OOM, corruption, and skipped CUDA evidence in logs", () => {
    for (const signal of [
      "fallback to CPU",
      "CUDA out of memory",
      "corrupted model input",
      "SKIPPED CUDA kernel",
    ]) {
      const files = fixture({ log: `CUDA started\n${signal}\n` });
      assert.throws(() => assemble(files), /fail-closed signals/);
    }
  });

  it("rejects a non-exact workflow head", () => {
    const files = fixture();
    const probe = JSON.parse(fs.readFileSync(files.probe, "utf8"));
    probe.head = "c".repeat(40);
    fs.writeFileSync(files.probe, JSON.stringify(probe));
    assert.throws(() => assemble(files), /does not match expected/);
  });

  it("rejects partial artifact shards", () => {
    const manifest = assemble(fixture());
    manifest.artifacts = manifest.artifacts.filter(
      (entry) => entry.id !== "native-log",
    );
    assert.throws(
      () => validateManifest(manifest, { expectedHead: HEAD }),
      /artifact shard missing: native-log/,
    );
  });

  it("refuses missing or empty artifact inputs", () => {
    const files = fixture();
    fs.writeFileSync(files.capabilities, "");
    assert.throws(() => assemble(files), /required artifact missing or empty/);
  });
});
