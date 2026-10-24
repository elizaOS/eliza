/**
 * An engine whose container query failed must not be read as an engine that
 * has no containers: the orphan sweep in `SandboxManager` treats the returned
 * list as the complete set of containers from previous runs.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test__ } from "./sandbox-engine.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sandbox-engine-list-"));
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

async function writeFakeEngine(scriptBody: string): Promise<string> {
  const binary = path.join(tempDir, "fake-engine");
  await fsp.writeFile(binary, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  return binary;
}

describe("sandbox engine container listing", () => {
  it("reports a failed container query instead of an empty list", async () => {
    const binary = await writeFakeEngine(
      'echo "Cannot connect to the Docker daemon" >&2\nexit 1',
    );

    let thrown: unknown;
    try {
      __test__.listContainersFromBinary(binary, "eliza-sandbox");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "SANDBOX_CONTAINER_LIST_FAILED" });
  });

  it("keeps an engine that reports no containers as an empty list", async () => {
    const binary = await writeFakeEngine("exit 0");

    expect(__test__.listContainersFromBinary(binary, "eliza-sandbox")).toEqual([]);
  });
});
