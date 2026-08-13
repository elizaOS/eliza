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
    /RUN --mount=type=bind,from=llama-builder,source=\/tmp\/libcuda\.so\.1,target=\/tmp\/libcuda\.so\.1,ro \\\n    LD_LIBRARY_PATH=\/tmp llama-server --version/,
  );
  assert.doesNotMatch(dockerfile, /COPY[^\n]*libcuda\.so/);
});

test("publication workflow rebuilds the image consumed by vast", async () => {
  const [workflow, runner] = await Promise.all([
    readFile(workflowUrl, "utf8"),
    readFile(runnerUrl, "utf8"),
  ]);

  assert.match(workflow, /file: scripts\/vast\/Dockerfile\.gpu/);
  assert.match(workflow, /packages: write/);
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
