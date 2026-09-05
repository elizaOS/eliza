/** Bundles the cloud APNs provider and verifies its WebCrypto path in a real Workerd isolate. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

describe("Cloud APNs provider Workerd boundary", () => {
  let buildDirectory: string;
  let miniflare: Miniflare;

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), "eliza-apns-workerd-"));
    const coreDirectory = fileURLToPath(
      new URL("../../../core/", import.meta.url),
    );
    const coreBuild = Bun.spawn({
      cmd: [process.execPath, "build.ts", "--edge-only"],
      cwd: coreDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [coreBuildExitCode, coreBuildStdout, coreBuildStderr] =
      await Promise.all([
        coreBuild.exited,
        new Response(coreBuild.stdout).text(),
        new Response(coreBuild.stderr).text(),
      ]);
    if (coreBuildExitCode !== 0) {
      throw new Error(
        `Failed to build @elizaos/core/edge:\n${coreBuildStdout}\n${coreBuildStderr}`,
      );
    }
    const entrypoint = fileURLToPath(
      new URL("../test/fixtures/apns-provider-worker.ts", import.meta.url),
    );
    const outputPath = join(buildDirectory, "worker.mjs");
    const result = await Bun.build({
      entrypoints: [entrypoint],
      format: "esm",
      target: "browser",
      conditions: ["worker"],
      external: ["node:*"],
      minify: true,
      plugins: [
        {
          name: "eliza-core-edge-boundary",
          setup(build) {
            // Match the deployed Worker artifact instead of following the
            // workspace TypeScript alias into core's unbundled source graph.
            build.onResolve({ filter: /^@elizaos\/core\/edge$/ }, () => ({
              path: join(coreDirectory, "dist/edge/index.edge.js"),
            }));
          },
        },
      ],
    });
    if (!result.success) {
      throw new Error(
        `Failed to bundle APNs Workerd fixture: ${result.logs.join("\n")}`,
      );
    }
    const output = result.outputs[0];
    if (!output) throw new Error("APNs Workerd fixture bundle was not emitted");
    await Bun.write(outputPath, output);
    miniflare = new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      modules: [
        {
          type: "ESModule",
          path: "worker.mjs",
          contents: await readFile(outputPath, "utf8"),
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await miniflare?.dispose();
    if (buildDirectory) await rm(buildDirectory, { recursive: true });
  });

  test("signs, verifies, and reuses one sandbox provider token", async () => {
    const response = await miniflare.dispatchFetch("https://apns.test/");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toEqual({
      accepted: true,
      collapseIds: [expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)],
      jwtHeaders: [expect.stringMatching(/^bearer [^.]+\.[^.]+\.[^.]+$/)],
      sandbox: true,
      topic: "ai.elizaos.app",
      verified: true,
    });
  });
});
