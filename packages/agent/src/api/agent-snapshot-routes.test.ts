/**
 * Drives schema-v2 snapshot and restore through a real Node HTTP server so
 * route selection, headers, request streaming, and boundary errors are covered
 * together with the filesystem-backed transfer implementation.
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSnapshotUpgradeBinding } from "../services/agent-backup.ts";
import {
  AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
  parseCanonicalSnapshotStreamFrame,
} from "../services/agent-snapshot-stream-protocol.ts";
import { handleAgentSnapshotRoutes } from "./agent-snapshot-routes.ts";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  ELIZA_SNAPSHOT_SOURCE_ENVIRONMENT_REVISION:
    process.env.ELIZA_SNAPSHOT_SOURCE_ENVIRONMENT_REVISION,
  ELIZA_SNAPSHOT_SOURCE_IMAGE_DIGEST:
    process.env.ELIZA_SNAPSHOT_SOURCE_IMAGE_DIGEST,
  ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID:
    process.env.ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID,
  ELIZA_SNAPSHOT_RESTORE_BACKUP_ID:
    process.env.ELIZA_SNAPSHOT_RESTORE_BACKUP_ID,
  ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID:
    process.env.ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID,
  ELIZA_SNAPSHOT_RESTORE_NONCE: process.env.ELIZA_SNAPSHOT_RESTORE_NONCE,
  ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID:
    process.env.ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID,
  ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION:
    process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION,
  ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST:
    process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST,
  ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID:
    process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID,
  ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST:
    process.env.ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
  POSTGRES_URL: process.env.POSTGRES_URL,
};
const roots = new Set<string>();
const servers = new Set<http.Server>();
const AGENT_ID = "91000000-0000-4000-8000-000000000001";
const POSTGRES_URL =
  "postgres://owner:secret@db.example.com:5432/eliza?schema=tenant";
const UPGRADE_BINDING: AgentSnapshotUpgradeBinding = {
  backupId: "11111111-1111-4111-8111-111111111111",
  captureNonce: "a".repeat(64),
  sourceEnvironmentRevision: 7,
  sourceImageDigest: `sha256:${"b".repeat(64)}`,
  sourceSandboxId: "33333333-3333-4333-8333-333333333333",
  targetImageDigest: `sha256:${"c".repeat(64)}`,
  targetReplacementAttemptId: "22222222-2222-4222-8222-222222222222",
  targetSandboxId: "agent-target",
};

function candidateRestoreHeaders(): Record<string, string> {
  return {
    "content-type": AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
    "x-eliza-snapshot-backup-id": UPGRADE_BINDING.backupId,
    "x-eliza-snapshot-capture-nonce": UPGRADE_BINDING.captureNonce,
    "x-eliza-snapshot-source-environment-revision": String(
      UPGRADE_BINDING.sourceEnvironmentRevision,
    ),
    "x-eliza-snapshot-source-image-digest": UPGRADE_BINDING.sourceImageDigest,
    "x-eliza-snapshot-source-sandbox-id": UPGRADE_BINDING.sourceSandboxId,
    "x-eliza-snapshot-target-image-digest": UPGRADE_BINDING.targetImageDigest,
    "x-eliza-snapshot-target-replacement-attempt-id":
      UPGRADE_BINDING.targetReplacementAttemptId,
    "x-eliza-snapshot-target-sandbox-id": UPGRADE_BINDING.targetSandboxId,
  };
}

function enableCandidateRestore(): void {
  process.env.ELIZA_SNAPSHOT_RESTORE_BACKUP_ID = UPGRADE_BINDING.backupId;
  process.env.ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID =
    UPGRADE_BINDING.targetReplacementAttemptId;
  process.env.ELIZA_SNAPSHOT_RESTORE_NONCE = UPGRADE_BINDING.captureNonce;
  process.env.ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID =
    UPGRADE_BINDING.targetSandboxId;
  process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION = String(
    UPGRADE_BINDING.sourceEnvironmentRevision,
  );
  process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST =
    UPGRADE_BINDING.sourceImageDigest;
  process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID =
    UPGRADE_BINDING.sourceSandboxId;
  process.env.ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST =
    UPGRADE_BINDING.targetImageDigest;
}

function enableSourceAttestation(): void {
  process.env.ELIZA_SNAPSHOT_SOURCE_ENVIRONMENT_REVISION = String(
    UPGRADE_BINDING.sourceEnvironmentRevision,
  );
  process.env.ELIZA_SNAPSHOT_SOURCE_IMAGE_DIGEST =
    UPGRADE_BINDING.sourceImageDigest;
  process.env.ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID =
    UPGRADE_BINDING.sourceSandboxId;
}

function runtimeStub(): AgentRuntime {
  return {
    adapter: {},
    agentId: AGENT_ID,
    character: { name: "Route Test Agent" },
    getSetting: (key: string) => (key === "POSTGRES_URL" ? POSTGRES_URL : null),
  } as unknown as AgentRuntime;
}

async function startServer(runtime: AgentRuntime): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (
        await handleAgentSnapshotRoutes({
          config: {} as never,
          method: req.method ?? "GET",
          pathname: url.pathname,
          req,
          res,
          runtime,
          url,
        })
      ) {
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.add(root);
  return root;
}

async function postSlowBody(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{
  body: string;
  responseBeforeFinalChunk: boolean;
  status: number;
}> {
  let responseStarted = false;
  let resolveResponse:
    | ((value: { body: string; status: number }) => void)
    | undefined;
  let rejectResponse: ((reason?: unknown) => void) | undefined;
  const responsePromise = new Promise<{ body: string; status: number }>(
    (resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    },
  );
  const request = http.request(
    url,
    {
      headers: {
        ...headers,
        "content-length": String(body.byteLength),
      },
      method: "POST",
    },
    (response) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolveResponse?.({
          body: Buffer.concat(chunks).toString(),
          status: response.statusCode ?? 0,
        }),
      );
    },
  );
  request.on("error", (error) => rejectResponse?.(error));
  const split = Math.max(1, body.byteLength - 1);
  request.write(body.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const responseBeforeFinalChunk = responseStarted;
  request.end(body.subarray(split));
  return {
    ...(await responsePromise),
    responseBeforeFinalChunk,
  };
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers.clear();
  restoreEnv();
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { force: true, recursive: true })),
  );
  roots.clear();
});

describe.sequential("agent snapshot HTTP routes", () => {
  test("streams exact chunked-v1 NDJSON and restores it through the query contract", async () => {
    const source = await temporaryRoot("eliza-route-source-");
    const target = await temporaryRoot("eliza-route-target-");
    await fs.mkdir(path.join(source, "skills"), { recursive: true });
    await fs.writeFile(path.join(source, "eliza.json"), '{"route":true}\n');
    await fs.writeFile(
      path.join(source, "skills", "route.json"),
      '{"captured":true}\n',
    );
    process.env.ELIZA_STATE_DIR = source;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    enableSourceAttestation();
    const baseUrl = await startServer(runtimeStub());

    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`, {
      body: JSON.stringify({
        binding: UPGRADE_BINDING,
        purpose: "pre-upgrade",
        schemaVersion: 2,
        transfer: "chunked-v1",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotResponse.headers.get("content-type")).toBe(
      AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
    );
    expect(snapshotResponse.headers.get("cache-control")).toBe("no-store");
    const body = Buffer.from(await snapshotResponse.arrayBuffer());
    const lines = body.subarray(0, -1).toString().split("\n");
    expect(
      parseCanonicalSnapshotStreamFrame(Buffer.from(lines[0] as string)),
    ).toMatchObject({
      binding: UPGRADE_BINDING,
      format: "elizaos.agent-snapshot-stream",
      schemaVersion: 2,
      transfer: "chunked-v1",
      type: "descriptor",
    });
    const trailer = parseCanonicalSnapshotStreamFrame(
      Buffer.from(lines.at(-1) as string),
    ) as {
      aggregateSha256: string;
      fileCount: number;
      totalBytes: number;
      type: string;
    };
    expect(trailer).toMatchObject({ type: "trailer" });

    process.env.ELIZA_STATE_DIR = target;
    enableCandidateRestore();
    const restoreResponse = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body,
        headers: candidateRestoreHeaders(),
        method: "POST",
      },
    );
    expect(restoreResponse.status).toBe(200);
    await expect(restoreResponse.json()).resolves.toEqual({
      aggregateSha256: trailer.aggregateSha256,
      binding: UPGRADE_BINDING,
      fileCount: trailer.fileCount,
      receiptStatus: "committed",
      requiresRestart: true,
      schemaVersion: 2,
      success: true,
      totalBytes: trailer.totalBytes,
      transfer: "chunked-v1",
    });
    const replayResponse = await postSlowBody(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      candidateRestoreHeaders(),
      body,
    );
    expect(replayResponse.responseBeforeFinalChunk).toBe(false);
    expect(replayResponse.status).toBe(200);
    expect(JSON.parse(replayResponse.body)).toMatchObject({
      aggregateSha256: trailer.aggregateSha256,
      binding: UPGRADE_BINDING,
      receiptStatus: "committed",
    });
    const truncatedReplay = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body: body.subarray(0, -1),
        headers: candidateRestoreHeaders(),
        method: "POST",
      },
    );
    expect(truncatedReplay.status).toBe(400);

    const divergentSource = await temporaryRoot(
      "eliza-route-divergent-source-",
    );
    await fs.mkdir(path.join(divergentSource, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(divergentSource, "eliza.json"),
      '{"route":"divergent"}\n',
    );
    await fs.writeFile(
      path.join(divergentSource, "skills", "route.json"),
      '{"captured":"different"}\n',
    );
    process.env.ELIZA_STATE_DIR = divergentSource;
    const divergentSnapshot = await fetch(`${baseUrl}/api/snapshot`, {
      body: JSON.stringify({
        binding: UPGRADE_BINDING,
        purpose: "pre-upgrade",
        schemaVersion: 2,
        transfer: "chunked-v1",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(divergentSnapshot.status).toBe(200);
    const divergentBody = Buffer.from(await divergentSnapshot.arrayBuffer());
    process.env.ELIZA_STATE_DIR = target;
    const divergentReplay = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body: divergentBody,
        headers: candidateRestoreHeaders(),
        method: "POST",
      },
    );
    expect(divergentReplay.status).toBe(409);
    await expect(
      fs.readFile(path.join(target, "skills", "route.json"), "utf8"),
    ).resolves.toBe('{"captured":true}\n');
  });

  test("rejects a source claim that differs from provider launch attestation", async () => {
    const source = await temporaryRoot("eliza-route-confused-source-");
    process.env.ELIZA_STATE_DIR = source;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    enableSourceAttestation();
    const baseUrl = await startServer(runtimeStub());

    const response = await fetch(`${baseUrl}/api/snapshot`, {
      body: JSON.stringify({
        binding: {
          ...UPGRADE_BINDING,
          sourceSandboxId: "55555555-5555-4555-8555-555555555555",
        },
        purpose: "pre-upgrade",
        schemaVersion: 2,
        transfer: "chunked-v1",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("does not match this source placement"),
    });
  });

  test("rejects transfer ambiguity and corrupt input without applying state", async () => {
    const target = await temporaryRoot("eliza-route-invalid-");
    process.env.ELIZA_STATE_DIR = target;
    enableCandidateRestore();
    const baseUrl = await startServer(runtimeStub());
    await fs.writeFile(path.join(target, "sentinel.txt"), "unchanged");

    const ambiguous = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1&transfer=chunked-v1`,
      {
        body: "{}\n",
        headers: candidateRestoreHeaders(),
        method: "POST",
      },
    );
    expect(ambiguous.status).toBe(400);

    const wrongContentType = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body: "{}\n",
        headers: { "content-type": "application/x-ndjson" },
        method: "POST",
      },
    );
    expect(wrongContentType.status).toBe(400);

    const truncated = await fetch(
      `${baseUrl}/api/restore?transfer=chunked-v1`,
      {
        body: `${JSON.stringify({
          agentId: AGENT_ID,
          binding: UPGRADE_BINDING,
          chunkSize: 262144,
          components: {},
          createdAt: new Date().toISOString(),
          files: [],
          format: "elizaos.agent-snapshot-stream",
          schemaVersion: 2,
          transfer: "chunked-v1",
          type: "descriptor",
        })}\n`,
        headers: candidateRestoreHeaders(),
        method: "POST",
      },
    );
    expect(truncated.status).toBe(400);
    await expect(
      fs.readFile(path.join(target, "sentinel.txt"), "utf8"),
    ).resolves.toBe("unchanged");
    await expect(fs.readdir(target)).resolves.toEqual([
      "backups",
      "sentinel.txt",
    ]);
  });
});
