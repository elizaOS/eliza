/**
 * Opt-in real Docker proof of exact-quarantine start and materializer commands.
 * The Node image and compiled Agent host must already exist locally. Only the
 * Linux boot-id path and daemon socket are translated for the local host;
 * Docker inspection, start, PID 1 probe, record materialization and replay are real.
 * This is not SSH, a production image, PRIMARY concurrency or a runtime boot.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3MaterializerRequest,
  canonicalizeAgentBackupRestoreV3MaterializerReceipt,
} from "@elizaos/shared";
import {
  buildExactRestoreQuarantineMaterializerCommand,
  buildExactRestoreQuarantineStartCommand,
} from "../docker-sandbox-provider";

const enabled = process.env.AGENT_RESTORE_V3_DOCKER_TESTS === "1";
const repo = fileURLToPath(new URL("../../../../../../..", import.meta.url));
const host = "/app/packages/agent/dist/services/agent-backup-restore-v3-quarantine-host.js";
const containers = new Set<string>();
const roots = new Set<string>();
function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 20_000 }).trim();
}
function created(args: string[]): string {
  const id = docker("create", "--pull", "never", ...args);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Expected a full test container ID");
  containers.add(id);
  return id;
}
function fixture(altered = false) {
  accessSync(
    path.join(repo, "packages/agent/dist/services/agent-backup-restore-v3-quarantine-host.js"),
  );
  const probe = created(["--network", "none", "--entrypoint", "/bin/true", "node:24.15.0-alpine"]);
  const descriptor = JSON.parse(
    docker("inspect", "--format", "{{json .ImageManifestDescriptor}}", probe),
  );
  const repoDigest: string = JSON.parse(
    docker("image", "inspect", "node:24.15.0-alpine", "--format", "{{json .RepoDigests}}"),
  )[0];
  const imageDigest = repoDigest.split("@")[1];
  const child = descriptor.digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || !/^sha256:[a-f0-9]{64}$/.test(child))
    throw new Error("Missing image descriptor authority");
  const imageName = "docker.io/library/node";
  const imageReference = `${imageName}@${imageDigest}`;
  const platform = `${descriptor.platform.os}/${descriptor.platform.architecture}`;
  if (platform !== "linux/arm64" && platform !== "linux/amd64")
    throw new Error("Unsupported native test platform");
  const agentId = randomUUID();
  const replacementAttemptId = randomUUID();
  const restoreAttemptId = randomUUID();
  const nodeRecordId = randomUUID();
  const nodeIncarnation = randomUUID();
  const nodeHistoryId = randomUUID();
  const labels = {
    "ai.elizaos.replacement-attempt": replacementAttemptId,
    "ai.elizaos.restore-attempt-id": restoreAttemptId,
    "ai.elizaos.restore-node-record-id": nodeRecordId,
    "ai.elizaos.restore-node-incarnation": nodeIncarnation,
    "ai.elizaos.restore-node-history-id": nodeHistoryId,
    "ai.elizaos.restore-image-digest": imageDigest,
    "ai.elizaos.restore-quarantine": "true",
  };
  const id = created([
    "--name",
    `agent-restore-${agentId}-${restoreAttemptId}`,
    "--network",
    "none",
    "--restart",
    "no",
    "--no-healthcheck",
    "--read-only",
    "--tmpfs",
    "/restore:rw,nosuid,nodev,mode=0700,size=64m",
    "--mount",
    `type=bind,source=${repo},target=/app,readonly`,
    ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--entrypoint",
    "/usr/bin/env",
    `${imageName}@${child}`,
    "-i",
    "/usr/local/bin/node",
    host,
    ...(altered ? ["start"] : []),
  ]);
  const parameters = {
    agentId,
    replacementAttemptId,
    containerId: id,
    exactRestore: {
      restoreAttemptId,
      imageDigest,
      imageReference,
      imagePlatformDigest: child,
      quarantine: true as const,
      target: { nodeId: "local-test", nodeRecordId, nodeIncarnation, nodeHistoryId, platform },
    },
  };
  const generated = buildExactRestoreQuarantineStartCommand(parameters);
  const root = mkdtempSync(path.join(os.tmpdir(), "restore-quarantine-command-"));
  roots.add(root);
  const boot = path.join(root, "boot-id");
  writeFileSync(boot, nodeIncarnation, { mode: 0o600 });
  const endpoint = docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}");
  if (!/^unix:\/\/[A-Za-z0-9/_.-]+$/.test(endpoint))
    throw new Error("Native proof requires a local Unix Docker socket");
  const translate = (command: string) =>
    command
      .replace("/proc/sys/kernel/random/boot_id", boot)
      .replaceAll("unix:///var/run/docker.sock", endpoint)
      .replaceAll("chmod 700 --", "chmod 700")
      .replaceAll("chmod 600 --", "chmod 600");
  const run = () =>
    spawnSync("/bin/sh", ["-c", translate(generated.command)], {
      encoding: "utf8",
      timeout: 20_000,
    });
  const materializerCommand = translate(buildExactRestoreQuarantineMaterializerCommand(parameters));
  return { id, run, receiptDigest: generated.receiptDigest, restoreAttemptId, materializerCommand };
}

async function exchange(
  command: string,
  request: AgentBackupRestoreV3MaterializerRequest,
  payload = Buffer.alloc(0),
) {
  const metadata = Buffer.from(JSON.stringify(request));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(metadata.length);
  const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
    bytes.fill(0);
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
    bytes.fill(0);
  });
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
  const timeout = setTimeout(() => child.stdin.destroy(), 20_000);
  child.stdin.on("error", () => child.stdin.destroy());
  try {
    child.stdin.write(prefix);
    child.stdin.write(metadata);
    child.stdin.write(payload);
    return await result;
  } finally {
    clearTimeout(timeout);
    child.stdin.destroy();
    prefix.fill(0);
    metadata.fill(0);
  }
}
afterEach(() => {
  for (const id of containers) docker("rm", "--force", id);
  containers.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

// Dedicated local-Docker lane; ordinary unit runs must not create resources.
describe.skipIf(!enabled)("exact quarantine start command over real Docker", () => {
  test("materializes and replays a real record only in the retained running quarantine", async () => {
    const f = fixture();
    const stopped = spawnSync("/bin/sh", ["-c", f.materializerCommand], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(stopped.status).not.toBe(0);
    expect(stopped.stdout).toBe("");
    expect(docker("inspect", "--format", "{{.State.Status}}", f.id)).toBe("created");
    expect(f.run().status).toBe(0);
    const remote = (source: string) =>
      docker(
        "exec",
        f.id,
        "/usr/bin/env",
        "-i",
        "/usr/local/bin/node",
        "--input-type=module",
        "-e",
        source,
      );
    const identities = JSON.parse(
      remote(`import fs from "node:fs/promises";
      await fs.mkdir("/restore/attempt", {mode:0o700});
      const id=async p=>{const s=await fs.stat(p,{bigint:true});return {device:String(s.dev),inode:String(s.ino)}};
      process.stdout.write(JSON.stringify({trustedRootIdentity:await id("/restore"),attemptRootIdentity:await id("/restore/attempt")}));`),
    );
    const payload = Buffer.from('{"name":"Exact quarantine QA","bio":["amber"],"plugins":[]}');
    const hash = createHash("sha256").update(payload).digest("hex");
    const request: AgentBackupRestoreV3MaterializerRequest = {
      version: 2,
      trustedRoot: "/restore",
      attemptRoot: "/restore/attempt",
      ...identities,
      session: {
        restoreAttemptId: f.restoreAttemptId,
        operationId: randomUUID(),
        expectedManifestSha256: "a".repeat(64),
        stagingHandle: randomUUID(),
        cleanupHandle: randomUUID(),
        executionToken: randomUUID(),
        cleanupRegistered: true,
        isolatedCandidate: true,
      },
      deadlineEpochMs: Date.now() + 60_000,
      method: "stageRecord",
      receipt: {
        componentIndex: 0,
        componentName: "character",
        dataIndex: 0,
        offsetBytes: 0,
        entry: null,
        payloadBytes: payload.length,
        payloadSha256: hash,
      },
    };
    const expected = (value: AgentBackupRestoreV3MaterializerRequest) => ({
      status: 0,
      stdout: createHash("sha256")
        .update(canonicalizeAgentBackupRestoreV3MaterializerReceipt(value))
        .digest("hex"),
      stderr: "",
    });
    expect(await exchange(f.materializerCommand, request, payload)).toEqual(expected(request));
    expect(await exchange(f.materializerCommand, request, payload)).toEqual(expected(request));
    const finish: AgentBackupRestoreV3MaterializerRequest = {
      ...request,
      method: "finishComponent",
      receipt: {
        componentIndex: 0,
        componentName: "character",
        descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0],
        dataFrameCount: 1,
        payloadBytes: payload.length,
        payloadSha256: hash,
        recordStreamContentHmacSha256: "b".repeat(64),
      },
    };
    expect(await exchange(f.materializerCommand, finish)).toEqual(expected(finish));
    const substitutedRoot = await exchange(f.materializerCommand, {
      ...finish,
      attemptRootIdentity: {
        ...finish.attemptRootIdentity,
        inode: String(BigInt(finish.attemptRootIdentity.inode) + 1n),
      },
    });
    expect(substitutedRoot.status).not.toBe(0);
    expect(substitutedRoot.stdout).toBe("");
    expect(substitutedRoot.stderr).toBe("");
    expect(
      remote(
        'import fs from "node:fs/promises";process.stdout.write(await fs.readFile("/restore/attempt/components/character/character.json","utf8"));',
      ),
    ).toBe(payload.toString());
    expect(docker("logs", f.id)).toBe("");
  }, 90_000);
  test("starts, probes and replays the same running host without replacing its process", () => {
    const f = fixture();
    const first = f.run();
    expect({ status: first.status, stdout: first.stdout, stderr: first.stderr }).toEqual({
      status: 0,
      stdout: f.receiptDigest,
      stderr: "",
    });
    const identity = docker("inspect", "--format", "{{.State.Pid}}|{{.State.StartedAt}}", f.id);
    const replay = f.run();
    expect({ status: replay.status, stdout: replay.stdout, stderr: replay.stderr }).toEqual({
      status: 0,
      stdout: f.receiptDigest,
      stderr: "",
    });
    expect(docker("inspect", "--format", "{{.State.Pid}}|{{.State.StartedAt}}", f.id)).toBe(
      identity,
    );
    expect(docker("logs", f.id)).toBe("");
  }, 60_000);
  test("rejects altered startup arguments without starting the exact retained container", () => {
    const f = fixture(true);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(docker("inspect", "--format", "{{.State.Status}}", f.id)).toBe("created");
  }, 60_000);
});
