/**
 * Builds the six repository-owned progressive-content targets for evidence
 * producers. Corpus sources are opened through the bounded verifier, and the
 * returned soak contract samples process and native-store resources directly.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { openProgressiveContentBoundedSource } from "../../corpus-tools/src/progressive-content-realization.ts";

const TARGET_FAMILIES = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
];

/** Instantiate each production factory exactly once under a private work root. */
export async function createProgressiveContentProductionFactories(input) {
  const workRoot = path.resolve(input.workRoot);
  const stateDir = path.join(workRoot, "state");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  process.env.ELIZA_STATE_DIR = stateDir;
  const [fileModule, toolModule, attachmentModule, sqlModule] =
    await Promise.all([
      import(
        "../../../plugins/plugin-coding-tools/src/testing/progressive-content-file-target.ts"
      ),
      import(
        "../../../plugins/plugin-coding-tools/src/testing/progressive-content-tool-output-target.ts"
      ),
      import(
        "../../agent/src/testing/progressive-content-attachment-target.ts"
      ),
      import(
        "../../../plugins/plugin-sql/src/testing/progressive-content-sql-targets.ts"
      ),
    ]);
  const file = await fileModule.createProgressiveFileTargetFactory({
    targetRoot: path.join(workRoot, "file"),
    agentId: "content-context-file-agent",
  });
  const sql = await sqlModule.createProgressiveSqlTargetFactories({
    dataRoot: path.join(workRoot, "sql"),
  });
  const attachment =
    attachmentModule.createProgressiveAttachmentTargetFactory();
  const toolOutput = toolModule.createProgressiveToolOutputTargetFactory({
    agentId: "content-context-tool-agent",
  });
  const factories = [file, ...sql, attachment, toolOutput];
  const families = new Set(factories.map(({ family }) => family));
  if (
    factories.length !== TARGET_FAMILIES.length ||
    TARGET_FAMILIES.some((family) => !families.has(family))
  ) {
    throw new TypeError(
      "production target factories lack exact six-family coverage",
    );
  }
  return factories;
}

/** Realize one corpus object and prove that bounded ingestion covered it once. */
export async function createProgressiveContentProductionTarget(input) {
  const factory = input.factories.find(
    ({ family }) => family === input.object.family,
  );
  if (!factory) throw new Error(`factory missing for ${input.object.family}`);
  const opened = await openProgressiveContentBoundedSource(
    input.corpusRoot,
    input.object,
  );
  try {
    const target = await factory.create({
      object: {
        id: input.object.id,
        family: input.object.family,
        byteLength: input.object.byteLength,
        sourceSha256: input.object.sourceSha256,
        sourceRevision: input.object.revision,
        format: input.object.format,
        authorizationScope: input.object.authorizationScope,
        canaries: input.object.canaries,
      },
      source: opened.source,
    });
    if (!opened.exactCoverage()) {
      await target.cleanup();
      throw new Error(`target did not consume ${input.object.id} exactly once`);
    }
    return target;
  } finally {
    await opened.close();
  }
}

function selectSoakObject(manifest, factory) {
  const candidates = manifest.objects.filter(
    (object) =>
      object.family === factory.family &&
      (factory.binaryPolicy === "native-bytes" ||
        (object.format !== "binary" && object.format !== "invalid-utf8")),
  );
  candidates.sort((left, right) => right.byteLength - left.byteLength);
  const selected = candidates[0];
  if (!selected) {
    throw new Error(`${factory.family} has no soak-eligible corpus object`);
  }
  return selected;
}

async function countFileDescriptors() {
  for (const directory of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return (await fs.readdir(directory)).length;
    } catch {
      // Try the next operating-system-specific process descriptor view.
    }
  }
  throw new Error("process file-descriptor inventory is unavailable");
}

/** Build fixed six-family soak targets and an observed resource sampler. */
export async function createProgressiveContentProductionSoakContract(input) {
  const factories = await createProgressiveContentProductionFactories({
    workRoot: input.workRoot,
  });
  const activeTargets = new Map();
  const targets = factories.map((factory) => {
    const object = selectSoakObject(input.manifest, factory);
    return {
      family: factory.family,
      adapterId: factory.adapterId,
      authoritativeStore: factory.authoritativeStore,
      productionMethod: factory.productionMethod,
      binaryPolicy: factory.binaryPolicy,
      async create() {
        const target = await createProgressiveContentProductionTarget({
          corpusRoot: input.corpusRoot,
          object,
          factories,
        });
        activeTargets.set(factory.family, target);
        return target;
      },
    };
  });
  return {
    targets,
    async measureResources() {
      const memory = process.memoryUsage();
      let temporaryArtifacts = 0;
      let databaseRows = 0;
      let walBytes = 0;
      for (const target of activeTargets.values()) {
        const snapshot = await target.inspect();
        temporaryArtifacts += snapshot.temporaryArtifacts;
        databaseRows += snapshot.databaseRows;
        walBytes += snapshot.walBytes;
      }
      return {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        fileDescriptors: await countFileDescriptors(),
        temporaryArtifacts,
        databaseRows,
        walBytes,
      };
    },
    async cleanup() {
      for (const target of activeTargets.values()) {
        await target.cleanup();
      }
      activeTargets.clear();
      await fs.rm(path.resolve(input.workRoot), { recursive: true });
    },
  };
}
