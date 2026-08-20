/**
 * Locks the vast.ai GPU image publication path to a driver-free BuildKit
 * smoke test while keeping the CUDA link stub out of the runtime image.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const dockerfileUrl = new URL("./Dockerfile.gpu", import.meta.url);
const workflowUrl = new URL(
  "../../.github/workflows/certification-image.yml",
  import.meta.url,
);
const runnerUrl = new URL("./run-certification.mjs", import.meta.url);

test("GPU image smoke test mounts the CUDA link stub ephemerally", async () => {
  const dockerfile = await readFile(dockerfileUrl, "utf8");

  assert.match(
    dockerfile,
    /install -m 0644 \/usr\/local\/cuda\/lib64\/stubs\/libcuda\.so \/tmp\/libcuda\.so\.1/,
  );
  assert.match(
    dockerfile,
    /RUN --mount=type=bind,from=llama-builder,source=\/tmp\/libcuda\.so\.1,target=\/tmp\/libcuda\.so\.1,ro \\\n {4}LD_LIBRARY_PATH=\/tmp llama-server --version/,
  );
  assert.doesNotMatch(dockerfile, /COPY[^\n]*libcuda\.so/);
});

test("baked llama-server satisfies the gpu-vision build floor", async () => {
  const dockerfile = await readFile(dockerfileUrl, "utf8");

  // llama.cpp reports `git rev-list --count HEAD` as its build number, so a
  // shallow clone bakes `version: 1` and serve.mjs rejects the image on the
  // billed instance. Keep the history that makes the count truthful.
  assert.doesNotMatch(dockerfile, /git clone[^\n]*--depth/);
  assert.match(
    dockerfile,
    /git clone --filter=blob:none --single-branch --branch "\$\{LLAMA_CPP_REF\}"/,
  );
  // The smoke test must apply the repo's own gate, not merely execute the
  // binary, and the gate's module must already be in the image when it runs.
  const assertionOffset = dockerfile.indexOf(
    "assertLlamaBuildSupported(readFileSync(",
  );
  assert.ok(
    assertionOffset > 0,
    "smoke test must run the version output through assertLlamaBuildSupported",
  );
  assert.ok(
    dockerfile.indexOf("COPY scripts/gpu-vision/setup.mjs") < assertionOffset,
    "gpu-vision lib must be copied before the build-floor assertion runs",
  );
});

test("the gpu-vision build floor rejects a shallow-clone version string", async () => {
  const { assertLlamaBuildSupported, MIN_LLAMA_BUILD } = await import(
    new URL("../gpu-vision/lib.mjs", import.meta.url).href
  );

  assert.throws(
    () => assertLlamaBuildSupported("version: 1 (44c51e5)\n"),
    /build 1 is too old/,
  );
  assert.equal(
    assertLlamaBuildSupported(`version: ${MIN_LLAMA_BUILD} (44c51e5)\n`),
    MIN_LLAMA_BUILD,
  );
});

test("publication workflow rebuilds the image consumed by vast", async () => {
  const [workflow, runner] = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(runnerUrl, "utf8"),
  ]);

  assert.match(workflow, /file: scripts\/vast\/Dockerfile\.gpu/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /name: Ensure Docker daemon access/);
  assert.match(workflow, /sudo -n setfacl -m "u:\$\(id -u\):rw"/);
  assert.match(workflow, /RUNNER_ENVIRONMENT:-/);
  assert.match(workflow, /driver: docker/);
  assert.doesNotMatch(workflow, /cache-(?:from|to): type=gha/);
  assert.match(
    workflow,
    /type=raw,value=latest,enable=\$\{\{ github\.ref == 'refs\/heads\/develop' \}\}/,
  );
  assert.match(workflow, /type=sha,prefix=sha-,format=short/);
  assert.match(
    runner,
    /DEFAULT_IMAGE = "ghcr\.io\/elizaos\/certification-gpu:latest"/,
  );
});
