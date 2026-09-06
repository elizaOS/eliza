#!/usr/bin/env bun
/**
 * Produces run-bound progressive-content evidence against a disposable real
 * PostgreSQL database. All six families run through the shared production
 * target harness; PostgreSQL seek plans and final database deletion are
 * observed separately without exposing the connection string.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createProgressiveFileTargetFactory } from "../../plugins/plugin-coding-tools/src/testing/progressive-content-file-target.ts";
import { createProgressiveToolOutputTargetFactory } from "../../plugins/plugin-coding-tools/src/testing/progressive-content-tool-output-target.ts";
import { createProgressivePostgresSqlTargetFactories } from "../../plugins/plugin-sql/src/testing/progressive-content-sql-targets.ts";
import { createProgressiveAttachmentTargetFactory } from "../agent/src/testing/progressive-content-attachment-target.ts";
import { verifyProgressiveContentCorpus } from "../corpus-tools/src/progressive-content.ts";
import { validateProgressiveContentPostgresEvidence } from "../corpus-tools/src/progressive-content-postgres-evidence.ts";
import { openProgressiveContentBoundedSource } from "../corpus-tools/src/progressive-content-realization.ts";
import { runProgressiveContentTargetHarness } from "../corpus-tools/src/progressive-content-target-harness.ts";

const SCRIPT_PATH = "packages/scripts/produce-content-context-postgres.mjs";
const SHA256 = /^[0-9a-f]{64}$/u;
const SQL_FAMILIES = ["document", "memory", "email"];

export function parsePostgresEvidenceArgs(argv) {
  const parsed = {};
  for (const argument of argv) {
    if (argument.startsWith("--commit=")) parsed.commit = argument.slice(9);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(parsed.commit ?? "")) {
    throw new Error("--commit must be an exact Git SHA");
  }
  return parsed;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databaseUrl(base, databaseName) {
  const scoped = new URL(base);
  scoped.pathname = `/${databaseName}`;
  scoped.searchParams.delete("options");
  return scoped.toString();
}

async function privateAtomicJson(output, value) {
  const destination = path.resolve(output);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.pending-${randomUUID()}`;
  const handle = await fs.open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
}

function summarizeExplainPlan(result, expectedIndexName, indexDefinition) {
  const envelope = result.rows[0]?.["QUERY PLAN"]?.[0];
  const root = envelope?.Plan;
  if (!root || typeof root !== "object") {
    throw new Error("PostgreSQL did not return a JSON execution plan");
  }
  const nodeTypes = [];
  const indexNames = [];
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  const visit = (node) => {
    nodeTypes.push(String(node["Node Type"] ?? "unknown"));
    if (typeof node["Index Name"] === "string")
      indexNames.push(node["Index Name"]);
    sharedHitBlocks += Number(node["Shared Hit Blocks"] ?? 0);
    sharedReadBlocks += Number(node["Shared Read Blocks"] ?? 0);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  if (!indexNames.includes(expectedIndexName)) {
    throw new Error(
      `PostgreSQL seek plan did not use ${expectedIndexName}; definition=${indexDefinition}; plan=${JSON.stringify(root)}`,
    );
  }
  return {
    indexName: expectedIndexName,
    nodeTypes,
    actualRows: Math.round(Number(root["Actual Rows"] ?? 0)),
    sharedHitBlocks: Math.round(sharedHitBlocks),
    sharedReadBlocks: Math.round(sharedReadBlocks),
    planningTimeMs: Number(envelope["Planning Time"] ?? 0),
    executionTimeMs: Number(envelope["Execution Time"] ?? 0),
  };
}

async function explainSqlSeek(pool, family, object) {
  const expectedIndexName =
    family === "document"
      ? "idx_document_source_byte_seek"
      : "idx_message_content_byte_seek";
  const definitionResult = await pool.query(
    "SELECT pg_get_indexdef(to_regclass($1)) AS definition",
    [expectedIndexName],
  );
  const indexDefinition = String(
    definitionResult.rows[0]?.definition ?? "absent",
  );
  const offset = Math.max(0, object.byteLength - 64 * 1024);
  const requestedEnd = offset + 64 * 1024;
  if (family === "document") {
    const identity = await pool.query(
      "SELECT agent_id, metadata->>'documentId' AS id FROM memories WHERE type = 'documents' AND metadata->>'sourceSha256' = $1 LIMIT 1",
      [object.sourceSha256],
    );
    const objectId = identity.rows[0]?.id;
    const agentId = identity.rows[0]?.agent_id;
    if (typeof objectId !== "string")
      throw new Error(`document identity absent for ${object.id}`);
    const result = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT id FROM memories
       WHERE type = 'document_fragments'
         AND agent_id = $1
         AND metadata->>'type' = 'fragment'
         AND metadata->>'fragmentRole' = 'source-segment'
         AND metadata->>'sourceSegmentVersion' = '1'
         AND metadata ? 'sourceByteEnd'
         AND metadata->>'documentId' = $2
         AND (metadata->>'documentRevision')::bigint = 1
         AND NOT (metadata ? 'revisionAttemptId')
         AND metadata->>'revisionAttemptId' IS NULL
         AND (metadata->>'sourceByteEnd')::bigint > $3
         AND (metadata->>'sourceByteStart')::bigint < $4
       ORDER BY agent_id, metadata->>'documentId',
                (metadata->>'documentRevision')::bigint,
                (metadata->>'sourceByteEnd')::bigint
       LIMIT 66`,
      [agentId, objectId, offset, requestedEnd],
    );
    return summarizeExplainPlan(result, expectedIndexName, indexDefinition);
  }
  const identity = await pool.query(
    "SELECT id, agent_id FROM memories WHERE type = 'messages' AND metadata->>'source' = $1 ORDER BY created_at DESC LIMIT 1",
    [family],
  );
  const objectId = identity.rows[0]?.id;
  const agentId = identity.rows[0]?.agent_id;
  if (typeof objectId !== "string")
    throw new Error(`${family} identity absent for ${object.id}`);
  const revision = `rev:${object.sourceSha256}`;
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id FROM memories
     WHERE type = 'message_content_segments'
       AND agent_id = $1
       AND metadata->>'type' = 'message-content-segment'
       AND metadata->>'messageId' = $2
       AND metadata->>'sourceKind' = 'message-text'
       AND NOT (metadata ? 'attachmentIdHash')
       AND metadata->>'attachmentIdHash' IS NULL
       AND metadata->>'sourceRevision' = $3
       AND (metadata->>'byteEnd')::bigint > $4
       AND (metadata->>'byteStart')::bigint < $5
     ORDER BY agent_id, metadata->>'messageId', metadata->>'sourceKind',
              metadata->>'attachmentIdHash', metadata->>'sourceRevision',
              (metadata->>'byteEnd')::bigint
     LIMIT 66`,
    [agentId, objectId, revision, offset, requestedEnd],
  );
  return summarizeExplainPlan(result, expectedIndexName, indexDefinition);
}

async function observeIndexVectors(input) {
  const factories = new Map(
    input.factories.map((factory) => [factory.family, factory]),
  );
  const vectors = [];
  const client = await input.pool.connect();
  try {
    // The disposable corpus has only one active target at a time, so PostgreSQL
    // reasonably prefers a sequential scan for ~160 rows. Disable that planner
    // alternative on this evidence connection to prove the production seek
    // predicate is index-compatible; the setting is recorded in each vector.
    await client.query("SET enable_seqscan = off");
    for (const family of SQL_FAMILIES) {
      const factory = factories.get(family);
      const object = input.manifest.objects
        .filter(
          (candidate) =>
            candidate.family === family &&
            candidate.format !== "binary" &&
            candidate.format !== "invalid-utf8" &&
            candidate.byteLength > 64 * 1024,
        )
        .sort((left, right) => right.byteLength - left.byteLength)[0];
      if (!factory || !object)
        throw new Error(`indexed ${family} target is absent`);
      const opened = await openProgressiveContentBoundedSource(
        input.corpusRoot,
        object,
      );
      let target;
      try {
        target = await factory.create({
          object: {
            id: object.id,
            family: object.family,
            byteLength: object.byteLength,
            sourceSha256: object.sourceSha256,
            sourceRevision: object.revision,
            format: object.format,
            authorizationScope: object.authorizationScope,
            canaries: object.canaries,
          },
          source: opened.source,
        });
        if (!opened.exactCoverage())
          throw new Error(`index target did not consume ${object.id}`);
        await client.query("ANALYZE memories");
        vectors.push({
          family,
          adapterId: factory.adapterId,
          productionMethod: factory.productionMethod,
          plannerSettings: { enableSeqscan: false },
          seekPlan: await explainSqlSeek(client, family, object),
        });
      } finally {
        await target?.cleanup();
        await opened.close();
      }
    }
  } finally {
    await client.query("RESET enable_seqscan");
    client.release();
  }
  return vectors;
}

async function productionFactories(input) {
  process.env.ELIZA_STATE_DIR = path.join(input.stateDir, "agent-state");
  await fs.mkdir(process.env.ELIZA_STATE_DIR, { recursive: true, mode: 0o700 });
  const file = await createProgressiveFileTargetFactory({
    targetRoot: path.join(input.stateDir, "file-targets"),
    agentId: "content-context-postgres-file-agent",
  });
  const sql = await createProgressivePostgresSqlTargetFactories({
    connectionString: input.connectionString,
  });
  return [
    file,
    ...sql,
    createProgressiveAttachmentTargetFactory(),
    createProgressiveToolOutputTargetFactory({
      agentId: "content-context-postgres-tool-agent",
    }),
  ];
}

async function produce(options) {
  const startedAt = performance.now();
  const memoryAtStart = process.memoryUsage();
  const peakMemory = {
    rss: memoryAtStart.rss,
    heapUsed: memoryAtStart.heapUsed,
    external: memoryAtStart.external,
  };
  const memorySampler = setInterval(() => {
    const current = process.memoryUsage();
    peakMemory.rss = Math.max(peakMemory.rss, current.rss);
    peakMemory.heapUsed = Math.max(peakMemory.heapUsed, current.heapUsed);
    peakMemory.external = Math.max(peakMemory.external, current.external);
  }, 25);
  memorySampler.unref?.();
  const corpusRoot = path.resolve(
    requiredEnvironment("ELIZA_CONTENT_CONTEXT_CORPUS_ROOT"),
  );
  const output = requiredEnvironment("ELIZA_CONTENT_CONTEXT_OUTPUT");
  const expectedManifestSha256 = requiredEnvironment(
    "ELIZA_CONTENT_CONTEXT_MANIFEST_SHA256",
  );
  if (!SHA256.test(expectedManifestSha256))
    throw new Error("manifest SHA is invalid");
  const manifest = await verifyProgressiveContentCorpus(corpusRoot);
  if (manifest.manifestSha256 !== expectedManifestSha256) {
    throw new Error(
      "corpus manifest identity differs from producer environment",
    );
  }
  const postgresUrl = requiredEnvironment("POSTGRES_URL");
  const parsedUrl = new URL(postgresUrl);
  if (!/^postgres(?:ql)?:$/u.test(parsedUrl.protocol)) {
    throw new Error("POSTGRES_URL must use the PostgreSQL protocol");
  }
  const databaseName = `eliza_ctx_${randomUUID().replaceAll("-", "")}`;
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-context-pg-state-"),
  );
  await fs.chmod(stateDir, 0o700);
  const bootstrap = new Pool({ connectionString: postgresUrl, max: 1 });
  let databaseCreated = false;
  let databaseDropped = false;
  let postDropProbe = "present";
  try {
    await bootstrap.query(
      `CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8'`,
    );
    databaseCreated = true;
    const scopedUrl = databaseUrl(postgresUrl, databaseName);
    const factories = await productionFactories({
      stateDir,
      connectionString: scopedUrl,
    });
    const targetHarness = await runProgressiveContentTargetHarness({
      corpusRoot,
      manifest,
      factories,
    });
    if (targetHarness.status !== "passed") {
      throw new Error("shared PostgreSQL target harness failed");
    }
    const sqlPool = new Pool({ connectionString: scopedUrl, max: 2 });
    let server;
    let indexVectors;
    let databaseSizeBytes;
    try {
      const serverResult = await sqlPool.query(
        "SELECT version() AS version, current_setting('server_version_num')::int AS version_num",
      );
      server = {
        version: String(serverResult.rows[0]?.version ?? ""),
        versionNum: Number(serverResult.rows[0]?.version_num ?? 0),
      };
      indexVectors = await observeIndexVectors({
        pool: sqlPool,
        corpusRoot,
        manifest,
        factories,
      });
      databaseSizeBytes = Number(
        (
          await sqlPool.query(
            "SELECT pg_database_size(current_database())::bigint AS bytes",
          )
        ).rows[0]?.bytes ?? 0,
      );
    } finally {
      await sqlPool.end();
    }
    const observedPostgresRows = targetHarness.entries.reduce(
      (total, entry) => {
        if (!SQL_FAMILIES.includes(entry.family)) return total;
        const realized = entry.receipts?.find(
          ({ phase }) => phase === "realized",
        );
        return total + Number(realized?.after.databaseRows ?? 0);
      },
      0,
    );
    await bootstrap.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    databaseDropped = true;
    const probe = await bootstrap.query(
      "SELECT count(*)::int AS count FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    postDropProbe =
      Number(probe.rows[0]?.count ?? 1) === 0 ? "absent" : "present";
    const memoryAtEnd = process.memoryUsage();
    const report = {
      schemaVersion: "elizaos.content-context.postgres.v4",
      status: "passed",
      backend: "postgres",
      commit: options.commit,
      corpusManifestSha256: manifest.manifestSha256,
      server,
      command: {
        executable: "bun",
        argv: [SCRIPT_PATH, `--commit=${options.commit}`],
        cwd: ".",
      },
      performance: {
        durationMs: performance.now() - startedAt,
        peakRssBytes: peakMemory.rss,
        peakHeapUsedBytes: peakMemory.heapUsed,
        peakExternalBytes: peakMemory.external,
        rssDeltaBytes: memoryAtEnd.rss - memoryAtStart.rss,
        heapUsedStartBytes: memoryAtStart.heapUsed,
        heapUsedEndBytes: memoryAtEnd.heapUsed,
        externalStartBytes: memoryAtStart.external,
        externalEndBytes: memoryAtEnd.external,
        databaseSizeBytes,
        observedPostgresRows,
      },
      targetHarness,
      indexVectors,
      cleanup: { databaseDropped, postDropProbe },
    };
    validateProgressiveContentPostgresEvidence(report, {
      commit: options.commit,
      corpusManifestSha256: manifest.manifestSha256,
      objects: manifest.objects.map((object) => ({
        id: object.id,
        family: object.family,
        format: object.format,
        byteLength: object.byteLength,
        sourceSha256: object.sourceSha256,
        revision: object.revision,
        authorizationScope: object.authorizationScope,
      })),
    });
    await privateAtomicJson(output, report);
    return report;
  } finally {
    clearInterval(memorySampler);
    if (databaseCreated && !databaseDropped) {
      // error-policy:J6 the producer reports the original failure after trying
      // to remove only its uniquely named disposable database.
      await bootstrap
        .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => {});
    }
    await bootstrap.end();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  produce(parsePostgresEvidenceArgs(process.argv.slice(2))).then(
    (report) =>
      process.stdout.write(`${JSON.stringify({ status: report.status })}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}

export { produce as produceContentContextPostgresEvidence };
