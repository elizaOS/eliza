/**
 * Exercises the restore-validation process through a real TCP server while
 * asserting its fail-closed boot contract and deliberately tiny route surface.
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import type {
  AgentSnapshotSourceAttestation,
  AgentSnapshotUpgradeBinding,
} from "../services/agent-backup.ts";
import { AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS } from "../services/agent-snapshot-restore-binding.ts";
import { createAgentSnapshotStream } from "../services/agent-snapshot-stream.ts";
import {
  AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
  AGENT_SNAPSHOT_STREAM_TRANSFER,
} from "../services/agent-snapshot-stream-protocol.ts";
import {
  type RestoreValidationServer,
  startRestoreValidationServer,
} from "./restore-validation-server.ts";

const AGENT_ID = "91000000-0000-4000-8000-000000000001";
const POSTGRES_URL =
  "postgres://owner:secret@db.example.com:5432/eliza?schema=tenant";
const BINDING: AgentSnapshotUpgradeBinding = {
  backupId: "11111111-1111-4111-8111-111111111111",
  captureNonce: "a".repeat(64),
  sourceEnvironmentRevision: 7,
  sourceImageDigest: `sha256:${"b".repeat(64)}`,
  sourceSandboxId: "33333333-3333-4333-8333-333333333333",
  targetImageDigest: `sha256:${"c".repeat(64)}`,
  targetReplacementAttemptId: "22222222-2222-4222-8222-222222222222",
  targetSandboxId: "agent-target",
};
const SOURCE_ATTESTATION: AgentSnapshotSourceAttestation = {
  sourceEnvironmentRevision: BINDING.sourceEnvironmentRevision,
  sourceImageDigest: BINDING.sourceImageDigest,
  sourceSandboxId: BINDING.sourceSandboxId,
};
const ENV_KEYS = [
  "DATABASE_URL",
  "ELIZA_API_BIND",
  "ELIZA_API_PORT",
  "ELIZA_PORT",
  "ELIZA_RUNTIME_BOOT_MODE",
  "ELIZA_SNAPSHOT_RESTORE_BACKUP_ID",
  "ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID",
  "ELIZA_SNAPSHOT_RESTORE_NONCE",
  "ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID",
  "ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION",
  "ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST",
  "ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID",
  "ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST",
  "ELIZA_STATE_DIR",
  "PGLITE_DATA_DIR",
  "PORT",
  "POSTGRES_URL",
  "SANDBOX_ROUTE_AGENT_ID",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const roots = new Set<string>();
const servers = new Set<RestoreValidationServer>();

function enableRestoreValidation(root: string): void {
  process.env.ELIZA_RUNTIME_BOOT_MODE = "restore-validation";
  process.env.ELIZA_STATE_DIR = root;
  process.env.POSTGRES_URL = POSTGRES_URL;
  delete process.env.DATABASE_URL;
  delete process.env.PGLITE_DATA_DIR;
  process.env.SANDBOX_ROUTE_AGENT_ID = AGENT_ID;
  process.env.ELIZA_SNAPSHOT_RESTORE_BACKUP_ID = BINDING.backupId;
  process.env.ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID =
    BINDING.targetReplacementAttemptId;
  process.env.ELIZA_SNAPSHOT_RESTORE_NONCE = BINDING.captureNonce;
  process.env.ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID =
    BINDING.targetSandboxId;
  process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION = String(
    BINDING.sourceEnvironmentRevision,
  );
  process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST =
    BINDING.sourceImageDigest;
  process.env.ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID =
    BINDING.sourceSandboxId;
  process.env.ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST =
    BINDING.targetImageDigest;
}

function restoreHeaders(): Record<string, string> {
  return {
    "content-type": AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.backupId]: BINDING.backupId,
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.captureNonce]: BINDING.captureNonce,
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.sourceEnvironmentRevision]: String(
      BINDING.sourceEnvironmentRevision,
    ),
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.sourceImageDigest]:
      BINDING.sourceImageDigest,
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.sourceSandboxId]:
      BINDING.sourceSandboxId,
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.targetImageDigest]:
      BINDING.targetImageDigest,
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.targetReplacementAttemptId]:
      BINDING.targetReplacementAttemptId,
    [AGENT_SNAPSHOT_RESTORE_BINDING_HEADERS.targetSandboxId]:
      BINDING.targetSandboxId,
  };
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.add(root);
  return root;
}

async function start(): Promise<RestoreValidationServer> {
  const server = await startRestoreValidationServer({
    installSignalHandlers: false,
    port: 0,
  });
  servers.add(server);
  return server;
}

function captureRuntime(): AgentRuntime {
  return {
    adapter: { close: async () => undefined },
    agentId: AGENT_ID,
    character: { name: "Restore Validation Source" },
    getSetting: (key: string) => (key === "POSTGRES_URL" ? POSTGRES_URL : null),
    stop: async () => undefined,
  } as unknown as AgentRuntime;
}

async function captureStream(source: string): Promise<Buffer> {
  process.env.ELIZA_STATE_DIR = source;
  process.env.POSTGRES_URL = POSTGRES_URL;
  const frames: Buffer[] = [];
  for await (const frame of createAgentSnapshotStream(
    captureRuntime(),
    BINDING,
    SOURCE_ATTESTATION,
  )) {
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return body.buffer;
}

function beginPausedRestoreRequest(
  url: string,
  bytes: Uint8Array,
): {
  finish(): void;
  response: Promise<{ body: string; status: number }>;
} {
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  let request!: http.ClientRequest;
  const response = new Promise<{ body: string; status: number }>(
    (resolve, reject) => {
      request = http.request(
        url,
        {
          headers: {
            ...restoreHeaders(),
            "content-length": String(bytes.byteLength),
          },
          method: "POST",
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on("end", () => {
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              status: incoming.statusCode ?? 0,
            });
          });
        },
      );
      request.on("error", reject);
      request.write(bytes.subarray(0, split));
    },
  );
  let finished = false;
  return {
    finish() {
      if (finished) return;
      finished = true;
      request.end(bytes.subarray(split));
    },
    response,
  };
}

async function waitForRestorePhase(
  url: string,
  expectedPhase: string,
): Promise<{ body: Record<string, unknown>; status: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${url}/api/health`);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.restorePhase === expectedPhase) {
      return { body, status: response.status };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Restore-validation server did not reach ${expectedPhase}`);
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true })));
  roots.clear();
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("restore-validation server", () => {
  test("starts fail closed and exposes only health and streamed restore", async () => {
    const root = await temporaryRoot("eliza-restore-minimal-routes-");
    enableRestoreValidation(root);
    const server = await start();

    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      activeMutations: 0,
      canRespond: false,
      mode: "restore-validation",
      ready: false,
      restorePhase: "accepting",
      restoreReady: true,
      status: "restore-ready",
    });
    expect((await fetch(`${server.url}/api/status`)).status).toBe(404);
    expect(
      (
        await fetch(`${server.url}/api/snapshot`, {
          body: "{}",
          method: "POST",
        })
      ).status,
    ).toBe(404);
    const wrongHealthMethod = await fetch(`${server.url}/api/health`, {
      method: "POST",
    });
    expect(wrongHealthMethod.status).toBe(405);
    expect(wrongHealthMethod.headers.get("allow")).toBe("GET");
    const wrongRestoreMethod = await fetch(`${server.url}/api/restore`);
    expect(wrongRestoreMethod.status).toBe(405);
    expect(wrongRestoreMethod.headers.get("allow")).toBe("POST");
  });

  test("rejects malformed startup configuration before binding", async () => {
    const root = await temporaryRoot("eliza-restore-minimal-startup-");
    enableRestoreValidation(root);
    delete process.env.ELIZA_SNAPSHOT_RESTORE_NONCE;
    await expect(
      startRestoreValidationServer({
        installSignalHandlers: false,
        port: 0,
      }),
    ).rejects.toThrow("partially configured");

    enableRestoreValidation(root);
    process.env.SANDBOX_ROUTE_AGENT_ID = "not-an-agent-id";
    await expect(
      startRestoreValidationServer({
        installSignalHandlers: false,
        port: 0,
      }),
    ).rejects.toThrow("SANDBOX_ROUTE_AGENT_ID");

    enableRestoreValidation(root);
    process.env.ELIZA_RUNTIME_BOOT_MODE = "restor-validation";
    await expect(
      startRestoreValidationServer({
        installSignalHandlers: false,
        port: 0,
      }),
    ).rejects.toThrow("Unsupported runtime boot mode");

    enableRestoreValidation(path.join(root, "missing"));
    await expect(
      startRestoreValidationServer({
        installSignalHandlers: false,
        port: 0,
      }),
    ).rejects.toThrow("state root is unavailable");
  });

  test("keeps protocol errors ready but fails health after an apply receipt", async () => {
    const root = await temporaryRoot("eliza-restore-minimal-failure-");
    await fs.writeFile(path.join(root, "sentinel.txt"), "unchanged");
    enableRestoreValidation(root);
    const server = await start();

    const missingTransfer = await fetch(`${server.url}/api/restore`, {
      body: "{}\n",
      headers: restoreHeaders(),
      method: "POST",
    });
    expect(missingTransfer.status).toBe(400);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);

    const invalidStream = await fetch(
      `${server.url}/api/restore?transfer=${AGENT_SNAPSHOT_STREAM_TRANSFER}`,
      {
        body: "{}\n",
        headers: restoreHeaders(),
        method: "POST",
      },
    );
    expect(invalidStream.status).toBe(400);
    const failedHealth = await fetch(`${server.url}/api/health`);
    expect(failedHealth.status).toBe(503);
    await expect(failedHealth.json()).resolves.toMatchObject({
      canRespond: false,
      ready: false,
      restorePhase: "failed",
      restoreReady: false,
      status: "restore-failed",
    });
    await expect(
      fs.readFile(path.join(root, "sentinel.txt"), "utf8"),
    ).resolves.toBe("unchanged");
  });

  test("applies and replays a real streamed restore without a runtime or database adapter", async () => {
    const source = await temporaryRoot("eliza-restore-minimal-source-");
    const target = await temporaryRoot("eliza-restore-minimal-target-");
    await fs.writeFile(path.join(source, "eliza.json"), '{"restored":true}\n');
    await fs.mkdir(path.join(source, "skills"), { recursive: true });
    await fs.writeFile(path.join(source, "skills", "proof.json"), '{"v":2}\n');
    const body = await captureStream(source);

    enableRestoreValidation(target);
    const server = await start();
    const restore = await fetch(
      `${server.url}/api/restore?transfer=${AGENT_SNAPSHOT_STREAM_TRANSFER}`,
      {
        body: requestBody(body),
        headers: restoreHeaders(),
        method: "POST",
      },
    );
    expect(restore.status).toBe(200);
    await expect(restore.json()).resolves.toMatchObject({
      binding: BINDING,
      receiptStatus: "committed",
      requiresRestart: true,
      success: true,
      transfer: AGENT_SNAPSHOT_STREAM_TRANSFER,
    });
    await expect(
      fs.readFile(path.join(target, "skills", "proof.json"), "utf8"),
    ).resolves.toBe('{"v":2}\n');

    const standbyHealth = await fetch(`${server.url}/api/health`);
    expect(standbyHealth.status).toBe(503);
    await expect(standbyHealth.json()).resolves.toMatchObject({
      canRespond: false,
      ready: false,
      requiresRestart: true,
      restorePhase: "standby",
      status: "restore-standby",
    });
    const replay = await fetch(
      `${server.url}/api/restore?transfer=${AGENT_SNAPSHOT_STREAM_TRANSFER}`,
      {
        body: requestBody(body),
        headers: restoreHeaders(),
        method: "POST",
      },
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      receiptStatus: "committed",
    });
  });

  test("reports applying while a real streamed restore is paused and reaches standby in place", async () => {
    const source = await temporaryRoot("eliza-restore-paused-source-");
    const target = await temporaryRoot("eliza-restore-paused-target-");
    await fs.writeFile(path.join(source, "eliza.json"), '{"paused":true}\n');
    const body = await captureStream(source);

    enableRestoreValidation(target);
    const server = await start();
    const paused = beginPausedRestoreRequest(
      `${server.url}/api/restore?transfer=${AGENT_SNAPSHOT_STREAM_TRANSFER}`,
      body,
    );
    try {
      const applying = await waitForRestorePhase(server.url, "applying");
      expect(applying.status).toBe(503);
      expect(applying.body).toMatchObject({
        activeMutations: 0,
        canRespond: false,
        ready: false,
        restorePhase: "applying",
        restoreReady: false,
        status: "restore-applying",
      });
    } finally {
      paused.finish();
    }

    const restored = await paused.response;
    expect(restored.status).toBe(200);
    expect(JSON.parse(restored.body)).toMatchObject({
      receiptStatus: "committed",
      requiresRestart: true,
      success: true,
    });
    const standby = await waitForRestorePhase(server.url, "standby");
    expect(standby.status).toBe(503);
    expect(standby.body).toMatchObject({
      activeMutations: 0,
      canRespond: false,
      ready: false,
      requiresRestart: true,
      restorePhase: "standby",
      status: "restore-standby",
    });
  });

  test("restores PGlite files without opening a target database adapter", async () => {
    const source = await temporaryRoot("eliza-restore-pglite-source-");
    const target = await temporaryRoot("eliza-restore-pglite-target-");
    const sourcePglite = path.join(source, "pglite");
    const targetPglite = path.join(target, "pglite");
    await fs.mkdir(path.join(sourcePglite, "base"), { recursive: true });
    await fs.writeFile(path.join(sourcePglite, "base", "1"), "pglite-page");
    process.env.ELIZA_STATE_DIR = source;
    process.env.PGLITE_DATA_DIR = sourcePglite;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const sourceRuntime = {
      adapter: { checkpointAndCloseForSnapshot: async () => undefined },
      agentId: AGENT_ID,
      character: { name: "PGlite Restore Source" },
      getSetting: (key: string) =>
        key === "PGLITE_DATA_DIR" ? sourcePglite : null,
      stop: async () => undefined,
    } as unknown as AgentRuntime;
    const frames: Buffer[] = [];
    for await (const frame of createAgentSnapshotStream(
      sourceRuntime,
      BINDING,
      SOURCE_ATTESTATION,
    )) {
      frames.push(frame);
    }

    enableRestoreValidation(target);
    delete process.env.POSTGRES_URL;
    process.env.PGLITE_DATA_DIR = targetPglite;
    const server = await start();
    const response = await fetch(
      `${server.url}/api/restore?transfer=${AGENT_SNAPSHOT_STREAM_TRANSFER}`,
      {
        body: requestBody(Buffer.concat(frames)),
        headers: restoreHeaders(),
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    await expect(
      fs.readFile(path.join(targetPglite, "base", "1"), "utf8"),
    ).resolves.toBe("pglite-page");
    await expect(response.json()).resolves.toMatchObject({
      receiptStatus: "committed",
      requiresRestart: true,
      success: true,
    });
  });
});
