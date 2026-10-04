/**
 * Real socket/process tests for serving a restored runtime: the exclusive boot
 * lock, and the private probe socket answered in-process and relayed by the
 * spawned one-shot probe client. The attestation body uses a fixture grant;
 * booting the full Agent runtime is covered by restore-generation.boot.test.ts.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBackupRestoreV3ProbeRequest } from "@elizaos/contracts/node";
import {
  agentBackupRestoreV3TokenSha256,
  canonicalizeAgentBackupRestoreV3ServingValue,
  verifyAgentBackupRestoreV3Attestation,
} from "@elizaos/contracts/node";
import { afterEach, expect, it } from "vitest";
import {
  type AgentBackupRestoreV3ConsumedGrant,
  type AgentBackupRestoreV3ProbeServer,
  acquireAgentBackupRestoreV3RuntimeLock,
  buildAgentBackupRestoreV3RuntimeAttestation,
  startAgentBackupRestoreV3ProbeServer,
} from "./agent-backup-restore-v3-restored-runtime-host";
import { prepareAgentBackupRestoreV3ServingRoots } from "./agent-backup-restore-v3-serving-controller";
import {
  encodeServingFrame,
  RESTORE_V3_RUNTIME_LOCK_FILE,
  resolveServingRoots,
} from "./agent-backup-restore-v3-serving-wire";

/** Load-tolerant test budget; no case here proves deadline expiry. */
const BUDGET_MS = 10 * 60_000;
const client = fileURLToPath(
  new URL("./agent-backup-restore-v3-probe-client.ts", import.meta.url),
);
const dataRoots = new Set<string>();
const servers = new Set<AgentBackupRestoreV3ProbeServer>();

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.clear();
  for (const root of dataRoots)
    await fs.rm(root, { recursive: true, force: true });
  dataRoots.clear();
});

async function attempt() {
  // Short real path keeps the unix socket under the macOS sun_path limit.
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "r3r-"));
  dataRoots.add(root);
  await fs.chmod(root, 0o700);
  const restoreAttemptId = randomUUID();
  const roots = resolveServingRoots(restoreAttemptId, root);
  const identities = await prepareAgentBackupRestoreV3ServingRoots(roots, {
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + BUDGET_MS,
  });
  const token = randomBytes(32).toString("base64url");
  const grant: AgentBackupRestoreV3ConsumedGrant = {
    version: 1,
    format: "elizaos.agent-backup.restore-v3-boot-grant.v1",
    agentId: randomUUID(),
    organizationId: randomUUID(),
    restoreAttemptId,
    containerId: randomBytes(32).toString("hex"),
    nodeIncarnation: randomUUID(),
    generation: {
      preparedReceipt: {},
      preparedReceiptSha256: "a".repeat(64),
      committedReceiptSha256: "b".repeat(64),
      runtimeRootIdentity: identities.runtimeRootIdentity,
      generationTrustedRootIdentity: identities.generationTrustedRootIdentity,
      generationRootIdentity: identities.generationRootIdentity,
    },
    tokenSha256: agentBackupRestoreV3TokenSha256(token),
  };
  return { root, roots, restoreAttemptId, token, grant };
}

async function runProbeClient(
  root: string,
  request: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx/esm"),
      client,
      `--test-only-data-root=${root}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "test" } },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), BUDGET_MS);
  try {
    child.stdin.end(
      encodeServingFrame(canonicalizeAgentBackupRestoreV3ServingValue(request)),
    );
    return { code: await closed, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

it(
  "answers a relayed probe with an attestation only the grant token verifies",
  async () => {
    const f = await attempt();
    const token = Buffer.from(f.token, "utf8");
    let alive = true;
    const seen: AgentBackupRestoreV3ProbeRequest[] = [];
    const server = await startAgentBackupRestoreV3ProbeServer({
      runtimeRoot: f.roots.runtimeRoot,
      restoreAttemptId: f.restoreAttemptId,
      answer: async (request) => {
        seen.push(request);
        return alive
          ? buildAgentBackupRestoreV3RuntimeAttestation(
              f.grant,
              token,
              request.nonce,
              { listenPort: 2138, characterName: "Served Restore QA" },
            )
          : null;
      },
    });
    servers.add(server);
    expect((await fs.lstat(server.socketPath)).mode & 0o777).toBe(0o600);
    const request = {
      version: 1,
      restoreAttemptId: f.restoreAttemptId,
      nonce: randomBytes(32).toString("hex"),
    };
    const result = await runProbeClient(f.root, request);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.endsWith("\n")).toBe(true);
    const attestation = JSON.parse(result.stdout);
    expect(result.stdout).toBe(
      `${canonicalizeAgentBackupRestoreV3ServingValue(attestation)}\n`,
    );
    expect(verifyAgentBackupRestoreV3Attestation(f.token, attestation)).toEqual(
      {
        version: 1,
        format: "elizaos.agent-backup.restore-v3-runtime-attestation.v1",
        agentId: f.grant.agentId,
        organizationId: f.grant.organizationId,
        restoreAttemptId: f.restoreAttemptId,
        containerId: f.grant.containerId,
        nodeIncarnation: f.grant.nodeIncarnation,
        committedReceiptSha256: f.grant.generation.committedReceiptSha256,
        tokenSha256: f.grant.tokenSha256,
        nonce: request.nonce,
        runtimeReady: true,
        listenPort: 2138,
        characterName: "Served Restore QA",
      },
    );
    expect(
      verifyAgentBackupRestoreV3Attestation(
        randomBytes(32).toString("base64url"),
        attestation,
      ),
    ).toBeNull();
    expect(
      verifyAgentBackupRestoreV3Attestation(f.token, {
        ...attestation,
        body: { ...attestation.body, listenPort: 2139 },
      }),
    ).toBeNull();
    expect(seen).toEqual([request]);

    // A runtime that is no longer alive closes the probe without an answer.
    alive = false;
    expect(
      await runProbeClient(f.root, {
        ...request,
        nonce: randomBytes(32).toString("hex"),
      }),
    ).toEqual({ code: 1, stdout: "", stderr: "" });
    // A probe for another attempt never reaches this runtime's socket.
    alive = true;
    expect(
      await runProbeClient(f.root, {
        ...request,
        restoreAttemptId: randomUUID(),
      }),
    ).toEqual({ code: 1, stdout: "", stderr: "" });
    expect(seen).toHaveLength(2);
    token.fill(0);
  },
  BUDGET_MS,
);

it(
  "holds one exclusive boot lock and replaces only a dead holder's stale lock",
  async () => {
    const f = await attempt();
    const lock = await acquireAgentBackupRestoreV3RuntimeLock(
      f.roots.runtimeRoot,
    );
    const lockFile = path.join(
      f.roots.runtimeRoot,
      RESTORE_V3_RUNTIME_LOCK_FILE,
    );
    expect(await fs.readFile(lockFile, "utf8")).toBe(`${process.pid}\n`);
    expect((await fs.lstat(lockFile)).mode & 0o777).toBe(0o600);
    await expect(
      acquireAgentBackupRestoreV3RuntimeLock(f.roots.runtimeRoot),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_SERVING_RUNTIME_LOCKED",
    });

    // A live foreign holder is never displaced.
    const holder = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    const holderExit = new Promise<void>((resolve) =>
      holder.once("close", () => resolve()),
    );
    try {
      await lock.release();
      await expect(fs.access(lockFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await fs.writeFile(lockFile, `${holder.pid}\n`, { mode: 0o600 });
      await expect(
        acquireAgentBackupRestoreV3RuntimeLock(f.roots.runtimeRoot),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_SERVING_RUNTIME_LOCKED",
      });
    } finally {
      holder.kill("SIGKILL");
      await holderExit;
    }
    // Once that holder is dead its lock is stale and exactly one boot proceeds.
    const replaced = await acquireAgentBackupRestoreV3RuntimeLock(
      f.roots.runtimeRoot,
    );
    expect(await fs.readFile(lockFile, "utf8")).toBe(`${process.pid}\n`);
    await expect(
      acquireAgentBackupRestoreV3RuntimeLock(f.roots.runtimeRoot),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_SERVING_RUNTIME_LOCKED",
    });
    replaced.releaseSync();
    await expect(fs.access(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  },
  BUDGET_MS,
);
