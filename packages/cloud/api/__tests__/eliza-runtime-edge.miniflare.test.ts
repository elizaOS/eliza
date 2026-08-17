/**
 * Bundles the public `@elizaos/core/edge` entry and boots AgentRuntime inside
 * Miniflare, proving construction and initialization in the Workerd runtime.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

describe("Eliza runtime Cloudflare entry", () => {
  let miniflare: Miniflare;
  let buildDirectory: string;

  beforeAll(async () => {
    buildDirectory = await mkdtemp(join(tmpdir(), "eliza-edge-workerd-"));
    const coreDirectory = fileURLToPath(
      new URL("../../../core/", import.meta.url),
    );
    const coreBuild = Bun.spawn({
      cmd: [process.execPath, "build.ts", "--edge-only"],
      cwd: coreDirectory,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [coreBuildExitCode, coreBuildStderr] = await Promise.all([
      coreBuild.exited,
      new Response(coreBuild.stderr).text(),
    ]);
    if (coreBuildExitCode !== 0) {
      throw new Error(
        `Failed to build @elizaos/core/edge:\n${coreBuildStderr}`,
      );
    }

    const entrypoint = fileURLToPath(
      new URL("../test/fixtures/eliza-runtime-edge-worker.ts", import.meta.url),
    );
    const outputPath = join(buildDirectory, "worker.mjs");
    const coreEdgeArtifact = join(coreDirectory, "dist/edge/index.edge.js");
    const buildProcess = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const result = await Bun.build({
					entrypoints: [process.env.ELIZA_EDGE_ENTRY],
					root: process.cwd(),
					format: "esm",
					target: "browser",
					conditions: ["worker"],
					external: ["node:*"],
					minify: true,
					plugins: [{
						name: "eliza-core-edge-boundary",
						setup(build) {
							// Pin the published edge artifact this suite just built. Without
							// the pin, the cloud tsconfig "paths" alias resolves
							// @elizaos/core/edge to core src, whose node-oriented feature
							// graph (fs-extra and friends) cannot even evaluate in Workerd.
							build.onResolve({ filter: /^@elizaos\\/core\\/edge$/ }, () => ({
								path: process.env.ELIZA_CORE_EDGE_ARTIFACT,
							}));
						},
					}],
				});
				if (!result.success) {
					for (const log of result.logs) console.error(log);
					process.exit(1);
				}
				const output = result.outputs[0];
				if (!output) throw new Error("Eliza edge runtime bundle was not emitted");
				await Bun.write(process.env.ELIZA_EDGE_OUTPUT, output);`,
      ],
      cwd: coreDirectory,
      env: {
        ...process.env,
        ELIZA_CORE_EDGE_ARTIFACT: coreEdgeArtifact,
        ELIZA_EDGE_ENTRY: entrypoint,
        ELIZA_EDGE_OUTPUT: outputPath,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      buildProcess.exited,
      new Response(buildProcess.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`Failed to bundle Eliza edge runtime:\n${stderr}`);
    }

    miniflare = new Miniflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        NODE_ENV: "production",
        SECRET_SALT: "edge-runtime-miniflare-secret-salt",
      },
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

  test("constructs and initializes the real AgentRuntime", async () => {
    const response = await miniflare.dispatchFetch("https://runtime.test/");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      character: "Shared Eliza Edge Probe",
      messageServiceReady: true,
      plugins: expect.arrayContaining(["basic-capabilities"]),
      didRespond: true,
      reply: "hello from the real edge runtime",
      delivered: ["hello from the real edge runtime"],
    });
  }, 120_000);
});
