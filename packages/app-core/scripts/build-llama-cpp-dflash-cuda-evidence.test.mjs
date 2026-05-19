import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { writeCapabilities } from "./build-llama-cpp-dflash.mjs";

function makeTempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-cuda-evidence-"));
  const buildDir = path.join(root, "build");
  const outDir = path.join(root, "out");
  const cacheDir = path.join(root, "llama.cpp");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(cacheDir, "ggml", "src", "ggml-cuda"), {
    recursive: true,
  });
  return { root, buildDir, outDir, cacheDir };
}

function stageCudaSources(cacheDir) {
  const cudaDir = path.join(cacheDir, "ggml", "src", "ggml-cuda");
  for (const file of [
    "turboquant.cuh",
    "convert.cu",
    "cpy.cu",
    "turbo-tcq.cu",
    "turbo-tcq.cuh",
    "qjl.cu",
    "qjl.cuh",
    "polarquant.cu",
    "polarquant.cuh",
  ]) {
    fs.writeFileSync(path.join(cudaDir, file), `// staged ${file}\n`);
  }
}

function stageDflashDraftSources(cacheDir) {
  fs.mkdirSync(path.join(cacheDir, "src", "models"), { recursive: true });
  fs.mkdirSync(path.join(cacheDir, "common"), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "src", "models", "dflash_draft.cpp"),
    "// dflash draft model\n",
  );
  fs.writeFileSync(
    path.join(cacheDir, "src", "llama-arch.cpp"),
    'register_arch("dflash-draft");\n',
  );
  fs.writeFileSync(
    path.join(cacheDir, "common", "speculative.cpp"),
    'COMMON_SPECULATIVE_TYPE_DFLASH; "dflash";\n',
  );
  fs.writeFileSync(
    path.join(cacheDir, "common", "arg.cpp"),
    "--spec-type common_speculative_types_from_names\n",
  );
}

function stageRunnableHelp(outDir) {
  const server = path.join(outDir, "llama-server");
  fs.writeFileSync(
    server,
    "#!/usr/bin/env bash\nprintf '%s\\n' 'dflash tbq3_0 tbq4_0 turbo3_tcq qjl q4_polar'\n",
  );
  fs.chmodSync(server, 0o755);
}

function stageCudaObjects(buildDir) {
  for (const file of [
    "dflash.cu.o",
    "turboquant.cu.o",
    "turbo-tcq.cu.o",
    "qjl.cu.o",
    "polarquant.cu.o",
  ]) {
    fs.writeFileSync(path.join(buildDir, file), "");
  }
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("linux CUDA capabilities require target-matching runtime dispatch evidence before publishable=true", () => {
  const { root, buildDir, outDir, cacheDir } = makeTempTree();
  try {
    stageCudaSources(cacheDir);
    stageDflashDraftSources(cacheDir);
    stageRunnableHelp(outDir);
    stageCudaObjects(buildDir);

    const capabilities = writeCapabilities({
      outDir,
      target: "linux-x64-cuda",
      buildDir,
      cacheDir,
      forkCommit: "test",
      binaries: ["llama-server"],
    });

    expect(capabilities.publishable).toBe(true);
    expect(capabilities.eliza1DefaultEligible).toBe(true);
    expect(capabilities.missingRequiredKernels).toEqual([]);
    expect(capabilities.runtimeDispatch.evidenceTargetLoaded).toBe(true);
    expect(capabilities.runtimeDispatch.kernels.qjl_full.status).toBe(
      "runtime-ready",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CUDA object/source scans fail closed when runtime evidence does not match the target", () => {
  const { root, buildDir, outDir, cacheDir } = makeTempTree();
  try {
    stageCudaSources(cacheDir);
    stageDflashDraftSources(cacheDir);
    stageCudaObjects(buildDir);

    const capabilities = withEnv(
      "ELIZA_DFLASH_ALLOW_INCOMPLETE_KERNELS_FOR_SMOKE",
      "1",
      () =>
        writeCapabilities({
          outDir,
          target: "windows-x64-cuda",
          buildDir,
          cacheDir,
          forkCommit: "test",
          binaries: ["llama-server"],
        }),
    );

    expect(capabilities.publishable).toBe(false);
    expect(capabilities.eliza1DefaultEligible).toBe(false);
    expect(capabilities.runtimeDispatch.evidenceTargetLoaded).toBe(false);
    expect(capabilities.missingRequiredKernels.sort()).toEqual([
      "polarquant",
      "qjl_full",
      "turbo3",
      "turbo3_tcq",
      "turbo4",
    ]);
    expect(capabilities.runtimeDispatch.kernels.turbo3.requiredSmoke).toMatch(
      /cuda_runner\.sh --report <path>/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
