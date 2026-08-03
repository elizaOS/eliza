/**
 * Guards the GPU certification image's CPU-build smoke test without requiring
 * a Docker daemon or weakening the production CUDA runtime contract.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const dockerfileUrl = new URL("./Dockerfile.gpu", import.meta.url);

describe("GPU certification image", () => {
  test("uses the CUDA link stub only as an ephemeral smoke-test mount", async () => {
    const dockerfile = await readFile(dockerfileUrl, "utf8");

    expect(dockerfile).toContain(
      "install -m 0644 /usr/local/cuda/lib64/stubs/libcuda.so /tmp/libcuda.so.1",
    );
    expect(dockerfile).toContain(
      "RUN --mount=type=bind,from=llama-builder,source=/tmp/libcuda.so.1,target=/tmp/libcuda.so.1,ro",
    );
    expect(dockerfile).toContain("LD_LIBRARY_PATH=/tmp llama-server --version");
    expect(dockerfile).not.toMatch(/COPY[^\n]*libcuda\.so/);
  });
});
