/** Verifies install-time fused setup and embedding artifacts without network access. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureEmbeddingArtifact,
  ensureFusedInferenceInstall,
  resolveEmbeddingArtifactPath,
} from "./ensure-fused-inference-install.mjs";

const readyEmbedding = async () => ({
  status: "ready",
  path: "/models/gte-small_fp16.gguf",
  downloaded: false,
});

test("a normal install initializes the pinned source and ensures the fused library", async () => {
  const calls = [];
  const result = await ensureFusedInferenceInstall({
    env: {},
    platform: "linux",
    repoRoot: "/repo",
    bunExecutable: "/bun",
    provision: false,
    ensureEmbedding: readyEmbedding,
    run(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(calls[0], {
    command: "git",
    args: [
      "submodule",
      "update",
      "--init",
      "--recursive",
      "plugins/plugin-local-inference/native/llama.cpp",
    ],
    options: { cwd: "/repo" },
  });
  assert.deepEqual(calls[1], {
    command: "/bun",
    args: [
      "/repo/packages/app-core/scripts/stage-desktop-fused-lib.mjs",
      "--ensure",
    ],
    options: { cwd: "/repo", env: {} },
  });
});

test("CI is not an implicit escape hatch", async () => {
  const calls = [];
  const result = await ensureFusedInferenceInstall({
    env: { CI: "true" },
    platform: "linux",
    repoRoot: "/repo",
    bunExecutable: "/bun",
    provision: false,
    ensureEmbedding: readyEmbedding,
    run(command, args) {
      calls.push([command, ...args]);
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(calls.length, 2);
});

test("missing Linux prerequisites are provisioned before the native build", async () => {
  const events = [];
  await ensureFusedInferenceInstall({
    env: {},
    platform: "linux",
    repoRoot: "/repo",
    bunExecutable: "/bun",
    findLinuxPackages: () => ["cmake", "build-essential"],
    ensureEmbedding: readyEmbedding,
    provisionLinux(packages) {
      events.push(["provision", ...packages]);
    },
    run(command) {
      events.push(["run", command]);
    },
  });

  assert.deepEqual(events, [
    ["run", "git"],
    ["provision", "cmake", "build-essential"],
    ["run", "/bun"],
  ]);
});

test("the explicit emergency escape hatch performs no native mutations", async () => {
  let called = false;
  const result = await ensureFusedInferenceInstall({
    env: { ELIZA_SKIP_FUSED_INFERENCE_SETUP: "1" },
    run() {
      called = true;
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(called, false);
});

function fixtureArtifact(bytes) {
  return {
    filename: "gte-small_fp16.gguf",
    repo: "fixture/embedding",
    revision: "fixture-revision",
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fixtureResponse(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

test("a missing embedding artifact is downloaded and hash-verified atomically", async () => {
  const repoRoot = mkdtempSync(
    path.join(os.tmpdir(), "fused-install-missing-"),
  );
  const bytes = Buffer.from("deterministic embedding fixture");
  const artifact = fixtureArtifact(bytes);
  const requests = [];
  try {
    const result = await ensureEmbeddingArtifact({
      env: { MODELS_DIR: "models" },
      repoRoot,
      artifact,
      async fetchImpl(url, options) {
        requests.push({ url, options });
        return fixtureResponse(bytes);
      },
    });

    const target = resolveEmbeddingArtifactPath({
      env: { MODELS_DIR: "models" },
      repoRoot,
    });
    assert.equal(result.downloaded, true);
    assert.deepEqual(readFileSync(target), bytes);
    assert.equal(requests.length, 1);
    assert.match(
      requests[0].url,
      /fixture\/embedding\/resolve\/fixture-revision/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a stale embedding artifact is replaced with verified bytes", async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "fused-install-stale-"));
  const env = { MODELS_DIR: "models" };
  const target = resolveEmbeddingArtifactPath({ env, repoRoot });
  const expected = Buffer.from("current embedding fixture");
  const artifact = fixtureArtifact(expected);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "stale");
    const result = await ensureEmbeddingArtifact({
      env,
      repoRoot,
      artifact,
      fetchImpl: async () => fixtureResponse(expected),
    });
    assert.equal(result.downloaded, true);
    assert.deepEqual(readFileSync(target), expected);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a current embedding artifact never touches the network", async () => {
  const repoRoot = mkdtempSync(
    path.join(os.tmpdir(), "fused-install-current-"),
  );
  const env = { MODELS_DIR: "models" };
  const target = resolveEmbeddingArtifactPath({ env, repoRoot });
  const expected = Buffer.from("current embedding fixture");
  const artifact = fixtureArtifact(expected);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, expected);
    const result = await ensureEmbeddingArtifact({
      env,
      repoRoot,
      artifact,
      fetchImpl: async () => {
        throw new Error("network must not be used");
      },
    });
    assert.equal(result.downloaded, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a corrupt download is rejected without replacing the existing artifact", async () => {
  const repoRoot = mkdtempSync(
    path.join(os.tmpdir(), "fused-install-corrupt-"),
  );
  const env = { MODELS_DIR: "models" };
  const target = resolveEmbeddingArtifactPath({ env, repoRoot });
  const expected = Buffer.from("expected embedding fixture");
  const artifact = fixtureArtifact(expected);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "stale");
    await assert.rejects(
      ensureEmbeddingArtifact({
        env,
        repoRoot,
        artifact,
        fetchImpl: async () =>
          fixtureResponse(Buffer.from("corrupt bytes of same length")),
      }),
      /mismatch/,
    );
    assert.equal(readFileSync(target, "utf8"), "stale");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
