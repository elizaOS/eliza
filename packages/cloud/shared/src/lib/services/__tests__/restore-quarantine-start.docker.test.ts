/**
 * Opt-in real Docker proof of the generated exact-quarantine start command.
 * The Node image and compiled Agent host must already exist locally. Only the
 * Linux boot-id path and daemon socket are translated for the local host;
 * Docker inspection, start, live PID 1 probe and receipt execution are real.
 * This is not SSH, a production image, PRIMARY concurrency or a runtime boot.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactRestoreQuarantineStartCommand } from "../docker-sandbox-provider";

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
  const generated = buildExactRestoreQuarantineStartCommand({
    agentId,
    replacementAttemptId,
    containerId: id,
    exactRestore: {
      restoreAttemptId,
      imageDigest,
      imageReference,
      imagePlatformDigest: child,
      quarantine: true,
      target: { nodeId: "local-test", nodeRecordId, nodeIncarnation, nodeHistoryId, platform },
    },
  });
  const root = mkdtempSync(path.join(os.tmpdir(), "restore-quarantine-command-"));
  roots.add(root);
  const boot = path.join(root, "boot-id");
  writeFileSync(boot, nodeIncarnation, { mode: 0o600 });
  const endpoint = docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}");
  if (!/^unix:\/\/[A-Za-z0-9/_.-]+$/.test(endpoint))
    throw new Error("Native proof requires a local Unix Docker socket");
  const command = generated.command
    .replace("/proc/sys/kernel/random/boot_id", boot)
    .replaceAll("unix:///var/run/docker.sock", endpoint)
    .replaceAll("chmod 700 --", "chmod 700")
    .replaceAll("chmod 600 --", "chmod 600");
  const run = () => spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 20_000 });
  return { id, run, receiptDigest: generated.receiptDigest };
}
afterEach(() => {
  for (const id of containers) docker("rm", "--force", id);
  containers.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

// Dedicated local-Docker lane; ordinary unit runs must not create resources.
describe.skipIf(!enabled)("exact quarantine start command over real Docker", () => {
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
