/**
 * Apple Container has no `-d`, so `AppleContainerEngine.runContainer` keeps the
 * spawned `container run` as a long-lived child that outlives the promise. Any
 * pipe held open on that child must therefore be drained for the container's
 * whole life, and any buffer filled from it must be bounded.
 *
 * Both tests drive the real spawn path through a stand-in `container`
 * executable resolved from the host-execution baseline, so they exercise the
 * process boundary rather than an engine mock.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppleContainerEngine,
  type ContainerRunOptions,
} from "./sandbox-engine.ts";

const RUN_OPTIONS: Omit<ContainerRunOptions, "name"> = {
  image: "eliza-sandbox:test",
  detach: true,
  mounts: [],
  env: {},
  network: "none",
  user: "",
  capDrop: [],
};

let binDirectory: string;
let sentinelPath: string;
let previousBaseline: string | undefined;

/** Installs the stand-in `container` executable for the next spawn. */
function installContainerStub(body: string): void {
  const stub = join(binDirectory, "container");
  writeFileSync(stub, `#!${process.execPath}\n${body}`);
  chmodSync(stub, 0o755);
}

async function waitForSentinel(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sentinelPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return existsSync(sentinelPath);
}

describe.skipIf(process.platform === "win32")(
  "Apple Container background run",
  () => {
    beforeAll(() => {
      binDirectory = mkdtempSync(join(tmpdir(), "eliza-container-stub-"));
      sentinelPath = join(binDirectory, "stdout-flushed");
      // The baseline is captured once per module registry, so every case in
      // this file resolves `container` from this one directory.
      previousBaseline = process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH;
      process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH = binDirectory;
    });

    afterAll(() => {
      // Other files can share this vitest worker, so the baseline override must
      // not outlive this suite.
      if (previousBaseline === undefined) {
        delete process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH;
      } else {
        process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH = previousBaseline;
      }
      rmSync(binDirectory, { recursive: true, force: true });
    });

    it("keeps draining container stdout after the start check resolves", async () => {
      // 300000 bytes is far past the 64KiB OS pipe buffer, so the write only
      // completes if the parent keeps reading (or never piped stdout at all).
      installContainerStub(
        [
          'const fs = require("node:fs");',
          `process.stdout.write("x".repeat(300000), () => {`,
          `  fs.writeFileSync(${JSON.stringify(sentinelPath)}, "");`,
          "});",
          // Just past the engine's 2s start check, so the child is treated as
          // running without being left orphaned once the test finishes.
          "setTimeout(() => process.exit(0), 2500);",
        ].join("\n"),
      );

      const engine = new AppleContainerEngine();
      await expect(
        engine.runContainer({ ...RUN_OPTIONS, name: "eliza-sandbox-stdout" }),
      ).resolves.toBe("eliza-sandbox-stdout");

      expect(await waitForSentinel(10_000)).toBe(true);
    }, 30_000);

    it("bounds the start-check stderr buffer", async () => {
      installContainerStub(
        [
          'process.stderr.write("e".repeat(400_000), () => {',
          "  process.exit(0);",
          "});",
        ].join("\n"),
      );

      const engine = new AppleContainerEngine();
      const error = await engine
        .runContainer({ ...RUN_OPTIONS, name: "eliza-sandbox-stderr" })
        .then(
          () => null,
          (thrown: unknown) => thrown as Error,
        );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/Apple Container exited immediately/);
      expect(error?.message).toContain("[truncated]");
      expect(error?.message.length).toBeLessThan(200_000);
    }, 30_000);
  },
);
