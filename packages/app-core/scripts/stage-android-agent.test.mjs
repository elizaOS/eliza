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

test("runtime downloads retry transient transport failures and publish atomically", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-retry-"));
  const target = path.join(tmp, "cache", "bun.zip");
  const delays = [];
  const logs = [];
  let attempts = 0;
  try {
    await __testables.downloadFile(
      "https://downloads.invalid/bun.zip",
      target,
      {
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new TypeError("fetch failed", {
              cause: Object.assign(new Error("other side closed"), {
                code: "UND_ERR_SOCKET",
              }),
            });
          }
          if (attempts === 2) {
            return new Response("temporarily unavailable", { status: 503 });
          }
          return new Response("verified artifact bytes", { status: 200 });
        },
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        log: (message) => {
          logs.push(message);
        },
      },
    );

    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1_000, 2_000]);
    assert.equal(fs.readFileSync(target, "utf8"), "verified artifact bytes");
    assert.equal(
      fs
        .readdirSync(path.dirname(target))
        .some((name) => name.startsWith("bun.zip.download-")),
      false,
    );
    assert.equal(logs.length, 2);
    assert.match(logs[0], /attempt 1\/3 failed/);
  } finally {
    removePathRecursive(tmp);
  }
});

test("runtime downloads do not retry permanent HTTP failures", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-http-"));
  const target = path.join(tmp, "bun.zip");
  let attempts = 0;
  try {
    await assert.rejects(
      __testables.downloadFile(
        "https://downloads.invalid/missing-bun.zip",
        target,
        {
          fetchImpl: async () => {
            attempts += 1;
            return new Response("missing", { status: 404 });
          },
          sleep: async () => {
            assert.fail("permanent HTTP failures must not sleep or retry");
          },
        },
      ),
      (error) => {
        assert.match(error.message, /after 1 attempt$/);
        assert.equal(error.cause?.name, "DownloadHttpError");
        assert.match(error.cause?.message, /HTTP 404/);
        return true;
      },
    );
    assert.equal(attempts, 1);
    assert.equal(fs.existsSync(target), false);
  } finally {
    removePathRecursive(tmp);
  }
});

test("runtime downloads exhaust bounded retries without publishing partial bytes", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-download-exhausted-"),
  );
  const target = path.join(tmp, "bun.zip");
  let attempts = 0;
  try {
    await assert.rejects(
      __testables.downloadFile("https://downloads.invalid/bun.zip", target, {
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError("fetch failed");
        },
        sleep: async () => {},
        maxAttempts: 2,
      }),
      /Failed to download .* after 2 attempts/,
    );
    assert.equal(attempts, 2);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    removePathRecursive(tmp);
  }
});

test("launch scripts record the real detached agent child status", () => {
  const script = __testables.LAUNCH_SCRIPT;
  const childScript = __testables.LAUNCH_CHILD_SCRIPT;

  assert.match(script, /DIAGNOSTICS_FILE=/);
  assert.match(script, /launch-child\.sh/);
  assert.match(childScript, /agent-child-started/);
  assert.match(childScript, /agent-child-exited/);
  assert.match(childScript, /startupTraceId/);
  assert.match(childScript, /agent_pid=\$!/);
  assert.match(childScript, /wait "\$agent_pid"/);
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
