/** Exercises stage android agent behavior with deterministic app-core test fixtures. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolvePinnedBunArtifact,
  stagePinnedBunArtifact,
} from "./lib/pinned-android-bun.mjs";

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

test("downloadFile retries transient fetch failures before writing the artifact", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-retry-"));
  const priorFetch = globalThis.fetch;
  const target = path.join(tmp, "bun-linux-aarch64-musl.zip");
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), {
          code: "UND_ERR_SOCKET",
        }),
      });
    }
    return new Response(Buffer.from("ok"));
  };
  try {
    await __testables.downloadFile(
      "https://example.invalid/runtime.zip",
      target,
      {
        retryDelayMs: 0,
      },
    );
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(target, "utf8"), "ok");
  } finally {
    globalThis.fetch = priorFetch;
    removePathRecursive(tmp);
  }
});

test("downloadFile does not retry permanent HTTP misses", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-download-404-"));
  const priorFetch = globalThis.fetch;
  const target = path.join(tmp, "missing.zip");
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("missing", { status: 404 });
  };
  try {
    await assert.rejects(
      () =>
        __testables.downloadFile(
          "https://example.invalid/missing.zip",
          target,
          {
            retryDelayMs: 0,
          },
        ),
      /HTTP 404 fetching https:\/\/example\.invalid\/missing\.zip/,
    );
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(target), false);
  } finally {
    globalThis.fetch = priorFetch;
    removePathRecursive(tmp);
  }
});

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

test("riscv64 Bun defaults to the external OS toolchain checkout", () => {
  const osRepositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-os-riscv64-bun-"),
  );
  const artifact = path.join(
    osRepositoryRoot,
    "packages",
    "os",
    "toolchains",
    "bun-riscv64",
    "dist",
    __testables.RISCV64_BUN_ARTIFACT_FILENAME,
  );
  try {
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, "fixture");
    const resolved = withEnv(
      {
        ELIZAOS_OS_REPO_ROOT: osRepositoryRoot,
        ELIZA_BUN_RISCV64_FILE: null,
      },
      () => __testables.riscv64BunFilePath(),
    );
    assert.equal(resolved, artifact);
  } finally {
    removePathRecursive(osRepositoryRoot);
  }
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

function pinnedBunFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-pinned-bun-"));
  const dir = "bun-linux-x64-musl";
  fs.mkdirSync(path.join(tmp, dir));
  const bytes = Buffer.from("known executable fixture bytes\n");
  fs.writeFileSync(path.join(tmp, dir, "bun"), bytes);
  const archive = path.join(tmp, "fixture.zip");
  execFileSync("zip", ["-q", "-r", archive, dir], { cwd: tmp });
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const artifact = {
    ...resolvePinnedBunArtifact("canary", "x64"),
    archiveSha256: sha(fs.readFileSync(archive)),
    binarySha256: sha(bytes),
  };
  return { tmp, archive, artifact, bytes, cacheDir: path.join(tmp, "cache") };
}

test("Android Bun pins resolve immutable asset IDs and accurate channel metadata", () => {
  for (const channel of ["stable", "canary"]) {
    for (const arch of ["x64", "aarch64"]) {
      const pin = resolvePinnedBunArtifact(channel, arch);
      assert.match(
        pin.url,
        /^https:\/\/api.github.com\/repos\/oven-sh\/bun\/releases\/assets\/[0-9]+$/,
      );
      assert.match(pin.archiveSha256, /^[a-f0-9]{64}$/);
      assert.match(pin.binarySha256, /^[a-f0-9]{64}$/);
      assert.match(pin.revision, /^[a-f0-9]{40}$/);
    }
  }
  assert.equal(
    resolvePinnedBunArtifact("canary", "x64").version,
    "1.4.3-canary.1",
  );
  assert.equal(resolvePinnedBunArtifact("stable", "x64").version, "1.3.14");
  assert.throws(
    () => resolvePinnedBunArtifact("canary", "unknown"),
    /Missing or invalid/,
  );
});

test("pinned Bun verifies a real ZIP and cache bytes independently of age", async () => {
  const f = pinnedBunFixture();
  try {
    const download = () => {
      throw new Error("unexpected network request");
    };
    const result = await stagePinnedBunArtifact({
      ...f,
      sourceFile: f.archive,
      download,
    });
    assert.deepEqual(fs.readFileSync(result.bunPath), f.bytes);
    assert.equal(result.source.artifact_sha256, f.artifact.archiveSha256);
    fs.utimesSync(result.bunPath, new Date(0), new Date(0));
    const cached = await stagePinnedBunArtifact({ ...f, download });
    assert.equal(cached.source.kind, "cache");
    fs.writeFileSync(result.bunPath, "altered cached executable");
    await assert.rejects(
      stagePinnedBunArtifact({ ...f, download }),
      /Cached Bun binary SHA-256 mismatch/,
    );
  } finally {
    removePathRecursive(f.tmp);
  }
});

test("pinned Bun rejects modified archives even with a previously valid cache", async () => {
  const f = pinnedBunFixture();
  try {
    await stagePinnedBunArtifact({ ...f, sourceFile: f.archive });
    fs.appendFileSync(f.archive, "tampered archive");
    await assert.rejects(
      stagePinnedBunArtifact({ ...f, sourceFile: f.archive }),
      /Bun archive SHA-256 mismatch/,
    );
  } finally {
    removePathRecursive(f.tmp);
  }
});

test("pinned Bun verifies downloaded ZIP and extracted executable before cache publication", async () => {
  const f = pinnedBunFixture();
  try {
    const download = async (url, target, options) => {
      assert.equal(url, f.artifact.url);
      assert.equal(options.headers.Accept, "application/octet-stream");
      fs.copyFileSync(f.archive, target);
    };
    await assert.rejects(
      stagePinnedBunArtifact({
        ...f,
        artifact: { ...f.artifact, binarySha256: "0".repeat(64) },
        download,
      }),
      /Bun executable SHA-256 mismatch/,
    );
    assert.deepEqual(fs.readdirSync(f.cacheDir), []);
    const result = await stagePinnedBunArtifact({ ...f, download });
    assert.deepEqual(fs.readFileSync(result.bunPath), f.bytes);
  } finally {
    removePathRecursive(f.tmp);
  }
});

test("pinned Bun fails closed on a corrupted download without publishing cache bytes", async () => {
  const f = pinnedBunFixture();
  try {
    await assert.rejects(
      stagePinnedBunArtifact({
        ...f,
        download: async (_url, target) =>
          fs.writeFileSync(target, "not the pinned archive"),
      }),
      /Bun archive SHA-256 mismatch/,
    );
    assert.deepEqual(fs.readdirSync(f.cacheDir), []);
  } finally {
    removePathRecursive(f.tmp);
  }
});

test("artifact downloads preserve GitHub binary content negotiation", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bun-headers-"));
  try {
    const target = path.join(tmp, "artifact.zip");
    await __testables.downloadFile(
      "https://api.github.com/repos/oven-sh/bun/releases/assets/1",
      target,
      {
        headers: { Accept: "application/octet-stream" },
        fetchImpl: async (_url, options) => {
          assert.equal(options.headers.Accept, "application/octet-stream");
          return new Response("archive transport fixture");
        },
      },
    );
    assert.equal(fs.readFileSync(target, "utf8"), "archive transport fixture");
  } finally {
    removePathRecursive(tmp);
  }
});
