/** Exercises stage android agent behavior with deterministic app-core test fixtures. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  __testables,
  stageSeccompShimForAbi,
} from "./lib/stage-android-agent.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

function removePathRecursive(targetPath) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function withEnv(values, fn) {
  const prior = {};
  for (const key of Object.keys(values)) {
    prior[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("riscv64 Bun artifact path resolves from the ELIZA_BUN_RISCV64_FILE env", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-riscv64-bun-"));
  try {
    const artifact = path.join(tmp, __testables.RISCV64_BUN_ARTIFACT_FILENAME);
    fs.writeFileSync(artifact, "fixture");
    const resolved = withEnv(
      {
        ELIZA_BUN_RISCV64_FILE: artifact,
      },
      () => __testables.riscv64BunFilePath(),
    );
    assert.equal(resolved, artifact);
  } finally {
    removePathRecursive(tmp);
  }
});

test("riscv64 Bun artifact hash resolves from the ELIZA_BUN_RISCV64_SHA256 env", () => {
  const hash = "a".repeat(64);
  const resolved = withEnv(
    {
      ELIZA_BUN_RISCV64_SHA256: hash,
    },
    () => __testables.riscv64BunSha256(),
  );
  assert.equal(resolved, hash);
});

test("SIGSYS shim Zig auto-provision uses pinned release metadata for this host", () => {
  const toolchain = __testables.resolveZigToolchain();
  if (process.platform === "darwin" || process.platform === "linux") {
    assert.ok(toolchain);
    assert.match(
      toolchain.dirName,
      /^zig-(macos|linux)-(x86_64|aarch64)-0\.13\.0$/,
    );
    assert.match(toolchain.sha256, /^[a-f0-9]{64}$/);
  } else {
    assert.equal(toolchain, null);
  }
});

test("runtime provenance manifest name is exported for APK provenance embedding", () => {
  assert.equal(
    __testables.RUNTIME_PROVENANCE_FILENAME,
    "android-agent-runtime-provenance.json",
  );
});

test("launch script records the real detached agent child status", () => {
  const script = __testables.LAUNCH_SCRIPT;

  assert.match(script, /DIAGNOSTICS_FILE=/);
  assert.match(script, /agent-child-started/);
  assert.match(script, /agent-child-exited/);
  assert.match(script, /startupTraceId/);
  assert.match(script, /agent_pid=\$!/);
  assert.match(script, /wait "\$agent_pid"/);
  assert.doesNotMatch(script, /LD_LIBRARY_PATH="\$runtime_ld" exec "\$@"/);
});

test("stock Android staging fails when the required SIGSYS shim is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seccomp-missing-"));
  // Hermetic: an empty cache normally triggers the pinned-zig auto-provision
  // (download + compile); force it off so this asserts the hard error that
  // guards air-gapped/unsupported hosts.
  const priorNoProvision = process.env.ELIZA_SECCOMP_SHIM_NO_AUTOPROVISION;
  process.env.ELIZA_SECCOMP_SHIM_NO_AUTOPROVISION = "1";
  try {
    const abiAssetsDir = path.join(tmp, "assets", "arm64-v8a");
    fs.mkdirSync(abiAssetsDir, { recursive: true });
    const ldName = "ld-musl-aarch64.so.1";
    fs.writeFileSync(path.join(abiAssetsDir, ldName), Buffer.alloc(256 * 1024));

    assert.throws(
      () =>
        stageSeccompShimForAbi({
          androidAbi: "arm64-v8a",
          ldName,
          abiAssetsDir,
          cacheDir: path.join(tmp, "empty-cache"),
          log: () => {},
        }),
      /Missing compiled SIGSYS shim for arm64-v8a/,
    );
  } finally {
    if (priorNoProvision === undefined) {
      delete process.env.ELIZA_SECCOMP_SHIM_NO_AUTOPROVISION;
    } else {
      process.env.ELIZA_SECCOMP_SHIM_NO_AUTOPROVISION = priorNoProvision;
    }
    removePathRecursive(tmp);
  }
});

test("runtime provenance records repo-local riscv64 artifacts as relative paths", () => {
  const artifact = path.resolve(
    process.cwd(),
    "packages/app-core/scripts/bun-riscv64/dist",
    __testables.RISCV64_BUN_ARTIFACT_FILENAME,
  );
  const source = withEnv(
    {
      ELIZA_BUN_RISCV64_FILE: artifact,
    },
    () => __testables.riscv64BunArtifactSource(),
  );
  assert.deepEqual(source, {
    kind: "file",
    path: "packages/app-core/scripts/bun-riscv64/dist/bun-linux-riscv64-musl.zip",
    path_provenance: "relative_to_git_checkout",
  });
});

test("runtime provenance records external artifacts by basename only", () => {
  const artifact = path.join(
    os.tmpdir(),
    "eliza-external-riscv64",
    __testables.RISCV64_BUN_ARTIFACT_FILENAME,
  );
  const source = withEnv(
    {
      ELIZA_BUN_RISCV64_FILE: artifact,
    },
    () => __testables.riscv64BunArtifactSource(),
  );
  assert.deepEqual(source, {
    kind: "file",
    path: "bun-linux-riscv64-musl.zip",
    path_provenance: "external_artifact_basename",
  });
});
