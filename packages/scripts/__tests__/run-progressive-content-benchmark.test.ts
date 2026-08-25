/** Tests the fresh-process benchmark command contract without executing the production 1/10/100 MiB matrix. */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { progressiveConformanceFixture } from "../../core/src/testing/progressive-content-conformance.fixture";
import {
  PROGRESSIVE_CONTENT_BENCHMARK_FACTORY_SCHEMA_VERSION,
  parseProgressiveContentBenchmarkArgs,
  validateProgressiveContentBenchmarkFactory,
} from "../run-progressive-content-benchmark.mjs";

const commit = "a".repeat(40);
const execFileAsync = promisify(execFile);

describe("progressive content benchmark producer", () => {
  it("requires a run-bound parent invocation", () => {
    expect(() => parseProgressiveContentBenchmarkArgs([])).toThrow(
      /factory-module/u,
    );
    expect(
      parseProgressiveContentBenchmarkArgs([
        "--factory-module=/private/factory.mjs",
        "--out=/private/benchmark.json",
        `--commit=${commit}`,
      ]),
    ).toMatchObject({ worker: false, commit });
  });

  it("keeps size and repetition overrides worker-only", () => {
    expect(() =>
      parseProgressiveContentBenchmarkArgs([
        "--factory-module=/private/factory.mjs",
        "--out=/private/benchmark.json",
        `--commit=${commit}`,
        "--source-bytes=1",
      ]),
    ).toThrow(/worker-only/u);
    expect(
      parseProgressiveContentBenchmarkArgs([
        "--factory-module=/private/factory.mjs",
        "--worker-out=/private/sample.json",
        `--commit=${commit}`,
        "--source-bytes=1048576",
        "--repetition=5",
      ]),
    ).toMatchObject({
      worker: true,
      sourceBytes: 1_048_576,
      repetition: 5,
    });
  });

  it("requires an explicit production factory and complete resource sampler", () => {
    const valid = {
      schemaVersion: PROGRESSIVE_CONTENT_BENCHMARK_FACTORY_SCHEMA_VERSION,
      production: true,
      adapterId: "file-native-reader",
      productionMethod: "bounded-file-read",
      create() {},
      measureResources() {},
    };
    expect(validateProgressiveContentBenchmarkFactory(valid)).toBe(valid);
    expect(() =>
      validateProgressiveContentBenchmarkFactory({
        ...valid,
        measureResources: undefined,
      }),
    ).toThrow(/resource sampler/u);
    expect(() =>
      validateProgressiveContentBenchmarkFactory({
        ...valid,
        adapterId: "fixture-reader",
      }),
    ).toThrow(/production adapter/u);
  });

  it("executes a worker in a distinct process and records both phases", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "progressive-benchmark-test-"),
    );
    try {
      const factoryFile = path.join(root, "factory.mjs");
      const workerOut = path.join(root, "sample.json");
      const fixtureModule = pathToFileURL(
        fileURLToPath(
          new URL(
            "../../core/src/testing/progressive-content-conformance.fixture.ts",
            import.meta.url,
          ),
        ),
      ).href;
      await writeFile(
        factoryFile,
        `import { progressiveConformanceAdapter, progressiveConformanceFixture } from ${JSON.stringify(fixtureModule)};
export default {
  schemaVersion: ${JSON.stringify(PROGRESSIVE_CONTENT_BENCHMARK_FACTORY_SCHEMA_VERSION)},
  production: true,
  adapterId: "native-file-reader",
  productionMethod: "bounded-file-read",
  async create({ sourceBytes }) {
    const { object } = progressiveConformanceFixture();
    if (object.byteLength !== sourceBytes) throw new Error("size mismatch");
    const adapter = progressiveConformanceAdapter();
    return {
      family: "file",
      object,
      realization: {
        reference: { kind: "file", ref: "file:worker", revision: object.revision },
        sourceRevision: object.revision,
        authorizationMode: "principal",
        restartScope: "process",
        authorizationScopeDigest: "a".repeat(64),
        cleanupIdentity: "worker",
        resolverBindingSha256: object.sourceSha256,
      },
      read: ({ access, ...request }) => adapter.read({
        ...request,
        objectId: object.id,
        authorizationScope: access === "authorized" ? object.authorizationScope : "denied",
      }),
      restart: () => adapter.restart(),
      inspect: async () => ({ resolverGeneration: "worker", present: true, ownedBytes: object.byteLength, databaseRows: 1, temporaryArtifacts: 0, walBytes: 0 }),
      cleanup: () => adapter.cleanup(object.id),
    };
  },
  async measureResources({ target }) {
    const usage = process.memoryUsage();
    const snapshot = target ? await target.inspect() : { ownedBytes: 0, databaseRows: 0, walBytes: 0 };
    return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external, arrayBuffersBytes: usage.arrayBuffers, fileDescriptors: 4, databaseBytes: snapshot.ownedBytes, databaseRows: snapshot.databaseRows, walBytes: snapshot.walBytes };
  },
};
`,
        { mode: 0o600 },
      );
      const sourceBytes = progressiveConformanceFixture().object.byteLength;
      const script = fileURLToPath(
        new URL("../run-progressive-content-benchmark.mjs", import.meta.url),
      );
      await execFileAsync(process.execPath, [
        script,
        `--factory-module=${factoryFile}`,
        `--worker-out=${workerOut}`,
        `--commit=${commit}`,
        `--source-bytes=${sourceBytes}`,
        "--repetition=1",
      ]);
      const sample = JSON.parse(await readFile(workerOut, "utf8"));
      expect(sample.processId).not.toBe(process.pid);
      expect(sample.freshProcess).toBe(true);
      expect(sample.cold.bytesReturned).toBe(sourceBytes);
      expect(sample.warm.bytesReturned).toBe(sourceBytes);
      expect(sample.cold.pageLatencySamplesMs).toHaveLength(sample.cold.pages);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
