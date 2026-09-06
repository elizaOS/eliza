/**
 * Opt-in native Linux proof for the actual Docker exec stdin boundary.
 * Uses the built Agent worker in an exact-ID, networkless throwaway container;
 * only test-owned tmpfs/volume state is writable. Requires a completed package build
 * and AGENT_RESTORE_V3_DOCKER_TESTS=1; never substitutes pathname emulation.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3StagedRecord,
} from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import { snapshotAgentBackupRestoreV3CandidateRecord } from "./agent-backup-restore-v3-candidate-records";
import { materializerReceiptDigest } from "./agent-backup-restore-v3-materializer-wire";

const enabled = process.env.AGENT_RESTORE_V3_DOCKER_TESTS === "1";
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const worker =
  "/repo/packages/agent/dist/services/agent-backup-restore-v3-materializer-worker.js";
const validator =
  "/repo/packages/agent/dist/services/agent-backup-restore-v3-pglite-validation-worker.js";
const quarantineHost =
  "/repo/packages/agent/dist/services/agent-backup-restore-v3-quarantine-host.js";
const containers = new Set<string>();
const volumes = new Set<string>();
const roots = new Set<string>();
const exchanges = new Set<{
  disconnect: () => void;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
}>();
const control = () => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + 90_000,
});
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 15_000 });
}
function remote(id: string, source: string): string {
  return docker(
    "exec",
    id,
    "env",
    "-i",
    "/usr/local/bin/node",
    "--input-type=module",
    "-e",
    source,
  );
}

async function fixture(persistent = false) {
  await fs.access(
    path.join(
      repo,
      "packages/agent/dist/services/agent-backup-restore-v3-materializer-worker.js",
    ),
  );
  const image = docker(
    "image",
    "inspect",
    "node:24.15.0-alpine",
    "--format",
    "{{.Id}}",
  ).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(image))
    throw new Error("Expected one local image ID");
  const storageArgs = [
    "--tmpfs",
    "/restore:rw,nosuid,nodev,mode=0700,size=256m",
  ];
  if (persistent) {
    const volume = `restore-host-${randomUUID()}`;
    docker("volume", "create", "--label", "eliza.restore-test=true", volume);
    volumes.add(volume);
    storageArgs.splice(
      0,
      storageArgs.length,
      "--mount",
      `type=volume,source=${volume},target=/restore,volume-nocopy`,
    );
  }
  const id = docker(
    "create",
    "--name",
    `restore-stdio-${randomUUID()}`,
    "--network",
    "none",
    "--restart",
    "no",
    "--read-only",
    ...storageArgs,
    "--mount",
    `type=bind,source=${repo},target=/repo,readonly`,
    "--env",
    "NODE_OPTIONS=--import=data:text/javascript,throw%20new%20Error('ordinary-preload-must-not-run')",
    "--env",
    "APP_CMD_START=ordinary-boot-must-not-run",
    "--entrypoint",
    "/usr/bin/env",
    image,
    "-i",
    "/usr/local/bin/node",
    quarantineHost,
  ).trim();
  if (!/^[0-9a-f]{64}$/.test(id))
    throw new Error("Expected one full Docker container ID");
  containers.add(id);
  docker("start", id);
  const identity = JSON.parse(
    remote(
      id,
      `import fs from "node:fs/promises";
    await fs.chmod("/restore", 0o700);
    await fs.mkdir("/restore/attempt", {mode:0o700});
    const identity = async p => {const s=await fs.stat(p,{bigint:true});return {device:String(s.dev),inode:String(s.ino)}};
    process.stdout.write(JSON.stringify({trustedRootIdentity:await identity("/restore"),attemptRootIdentity:await identity("/restore/attempt")}));`,
    ),
  );
  const session = {
    restoreAttemptId: randomUUID(),
    operationId: randomUUID(),
    expectedManifestSha256: "a".repeat(64),
    stagingHandle: randomUUID(),
    cleanupHandle: randomUUID(),
    executionToken: randomUUID(),
    cleanupRegistered: true,
    isolatedCandidate: true,
  };
  const authority = {
    version: 2,
    trustedRoot: "/restore",
    attemptRoot: "/restore/attempt",
    ...identity,
    session,
  };
  const exchange = (
    method: string,
    receipt: unknown,
    payload: Uint8Array = new Uint8Array(),
    endInput = false,
  ) => {
    const metadata = Buffer.from(
      candidateFsCanonicalJson({
        ...authority,
        deadlineEpochMs: control().deadlineEpochMs,
        method,
        receipt,
      }),
    );
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.length);
    const child = spawn(
      "docker",
      ["exec", "-i", id, "env", "-i", "/usr/local/bin/node", worker],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      child.on("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        chunk.fill(0);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        chunk.fill(0);
      });
      child.stdin.on("error", () => {
        /* error-policy:J5 The failed exec exit is observed through done. */
      });
      child.once("close", (code) => {
        settled = true;
        resolve({ code, stdout, stderr });
      });
    });
    child.stdin.write(prefix);
    child.stdin.write(metadata);
    child.stdin.write(payload);
    if (endInput) child.stdin.end();
    const timer = setTimeout(() => child.stdin.destroy(), 90_000);
    const result = done.finally(() => {
      clearTimeout(timer);
      child.stdin.destroy();
      metadata.fill(0);
      prefix.fill(0);
    });
    const active = {
      result,
      disconnect: () => child.stdin.destroy(),
      loseClient: () => child.kill("SIGKILL"),
      settled: () => settled,
    };
    exchanges.add(active);
    return active;
  };
  const stage = async (record: AgentBackupRestoreV3StagedRecord) => {
    const copy = snapshotAgentBackupRestoreV3CandidateRecord(record, control());
    try {
      const result = await exchange("stageRecord", copy.receipt, copy.payload)
        .result;
      expect(result).toEqual({
        code: 0,
        stdout: materializerReceiptDigest(copy.receipt),
        stderr: "",
      });
      return copy.receipt;
    } finally {
      copy.payload.fill(0);
    }
  };
  return { id, stage, exchange, session };
}

afterEach(async () => {
  for (const exchange of exchanges) exchange.disconnect();
  await Promise.allSettled([...exchanges].map((exchange) => exchange.result));
  exchanges.clear();
  for (const id of containers) docker("rm", "--force", id);
  containers.clear();
  for (const volume of volumes) docker("volume", "rm", volume);
  volumes.clear();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

// Explicit Docker lane: ordinary unit runs must not create containers or pull images.
describe.skipIf(!enabled)("native Docker restore worker stdio", () => {
  it("starts and restarts only the quarantine host, preserving private materializer access without ordinary boot", async () => {
    const f = await fixture(true);
    const inspectHost = () =>
      JSON.parse(
        remote(
          f.id,
          `
      import fs from "node:fs/promises";
      const entries = await fs.readdir("/restore/attempt");
      const environment = await fs.readFile("/proc/1/environ", "utf8");
      const command = (await fs.readFile("/proc/1/cmdline", "utf8")).split("\\0").filter(Boolean);
      const tcp = await fs.readFile("/proc/1/net/tcp", "utf8");
      const tcp6 = await fs.readFile("/proc/1/net/tcp6", "utf8");
      process.stdout.write(JSON.stringify({entries, environment, command,
        listeners: [...tcp.split("\\n"), ...tcp6.split("\\n")].filter(line => /\\s0A\\s/.test(line))}));
    `,
        ),
      );
    expect(inspectHost()).toEqual({
      entries: [],
      environment: "",
      command: ["/usr/local/bin/node", quarantineHost],
      listeners: [],
    });
    const retained = "retained candidate is not an empty agent";
    remote(
      f.id,
      `import fs from "node:fs/promises"; await fs.writeFile("/restore/attempt/retained", ${JSON.stringify(retained)});`,
    );
    // A Docker restart must return to quarantine, never reinterpret retained
    // candidate files or APP_CMD_START as authorization for an ordinary boot.
    docker("restart", "--time", "5", f.id);
    expect(inspectHost()).toEqual({
      entries: ["retained"],
      environment: "",
      command: ["/usr/local/bin/node", quarantineHost],
      listeners: [],
    });
    expect(
      remote(
        f.id,
        `import fs from "node:fs/promises"; process.stdout.write(await fs.readFile("/restore/attempt/retained", "utf8"));`,
      ),
    ).toBe(retained);
    expect(docker("logs", f.id)).toBe("");
    docker("stop", "--time", "5", f.id);
    expect(
      docker("inspect", "--format", "{{.State.ExitCode}}", f.id).trim(),
    ).toBe("0");
  });

  it("reconciles an actual Linux process death after generation rename without replacing later live writes", async () => {
    const f = await fixture();
    // Synthetic preparation authority isolates the real rename/lock crash
    // boundary; the assembly suite proves all five actual restored components.
    const setup = `
      import fs from "node:fs/promises";
      import {createHash} from "node:crypto";
      import {openAgentBackupRestoreV3CandidateFs} from "/repo/packages/agent/dist/services/agent-backup-restore-v3-candidate-fs.js";
      import {candidateFsCanonicalJson} from "/repo/packages/agent/dist/services/agent-backup-restore-v3-candidate-fs-json.js";
      import {commitAgentBackupRestoreV3Generation} from "/repo/packages/agent/dist/services/agent-backup-restore-v3-generation-commit.js";
      const control = {signal:new AbortController().signal, deadlineEpochMs:Date.now()+30000};
      const identity = async p => {const s=await fs.stat(p,{bigint:true});return {device:String(s.dev),inode:String(s.ino)}};
    `;
    remote(
      f.id,
      `${setup}
      await fs.mkdir("/restore/private/attempt", {recursive:true,mode:0o700});
      await fs.mkdir("/restore/runtime", {mode:0o700});
      const candidate=await openAgentBackupRestoreV3CandidateFs({trustedRoot:"/restore/private",attemptRoot:"/restore/private/attempt",control});
      const lock=await candidate.acquireLock(".restore-v3-generation.lock",control);
      try {
        const writer=await candidate.createFileTreeFile("generation",{path:"state/fact.txt",sizeBytes:8,mode:0o600,mtimeMs:0},undefined,control,lock);
        await writer.write(new TextEncoder().encode("restored"),control); await writer.finalize(control);
        const tree=await candidate.inspectFileTree("generation",control,lock);
        const body={version:1,format:"elizaos.agent-backup.restore-v3-generation-prepared.v1",assemblySha256:"a".repeat(64),sourceTreeSha256:"b".repeat(64),targetRoot:candidate.attemptRootIdentity,paths:{character:"generation/character/character.json",database:"generation/database",state:"generation/state"},treeSha256:tree.sha256,files:tree.files,directories:tree.directories,bytes:tree.bytes};
        const prepared={...body,receiptSha256:createHash("sha256").update(candidateFsCanonicalJson(body)).digest("hex")};
        await candidate.publishDurableJson(".restore-v3-generation-prepared.json",prepared,{maximumBytes:16384},control,lock);
      } finally {await lock.release(control); await candidate.close()}
    `,
    );
    const request = `
      const candidate=await openAgentBackupRestoreV3CandidateFs({trustedRoot:"/restore/private",attemptRoot:"/restore/private/attempt",control});
      const preparedReceipt=JSON.parse(await fs.readFile("/restore/private/attempt/.restore-v3-generation-prepared.json","utf8"));
      const request={generationFs:candidate,preparedReceipt,runtimeRoot:"/restore/runtime",runtimeRootIdentity:await identity("/restore/runtime"),control};
    `;
    expect(() =>
      remote(
        f.id,
        `${setup}${request}
      const rename=fs.rename.bind(fs);
      fs.rename=async (source,target)=>{await rename(source,target); process.kill(process.pid,"SIGKILL");};
      await commitAgentBackupRestoreV3Generation(request);
    `,
      ),
    ).toThrow();
    const proof = JSON.parse(
      remote(
        f.id,
        `${setup}${request}
      const first=await commitAgentBackupRestoreV3Generation(request);
      const file=first.paths.state+"/fact.txt";
      const restored=await fs.readFile(file,"utf8");
      await fs.writeFile(file,"written by live runtime");
      const marker="/restore/private/attempt/.restore-v3-generation-committed.json";
      const before=await fs.stat(marker,{bigint:true});
      const replay=await commitAgentBackupRestoreV3Generation(request);
      const after=await fs.stat(marker,{bigint:true});
      process.stdout.write(JSON.stringify({restored,live:await fs.readFile(file,"utf8"),sameReceipt:JSON.stringify(first)===JSON.stringify(replay),markerUnchanged:before.ino===after.ino&&before.mtimeNs===after.mtimeNs,quarantineNames:await fs.readdir(candidate.attemptRoot)}));
      await candidate.close();
    `,
      ),
    );
    expect(proof.restored).toBe("restored");
    expect(proof.live).toBe("written by live runtime");
    expect(proof.sameReceipt).toBe(true);
    expect(proof.markerUnchanged).toBe(true);
    expect(proof.quarantineNames).not.toContain("generation");
  }, 45_000);

  it("copies generation files under two actual Linux inode locks without sharing source inodes", async () => {
    const f = await fixture();
    const proof = JSON.parse(
      remote(
        f.id,
        `
      import fs from "node:fs/promises";
      import {openAgentBackupRestoreV3CandidateFs} from "/repo/packages/agent/dist/services/agent-backup-restore-v3-candidate-fs.js";
      const control = {signal: new AbortController().signal, deadlineEpochMs: Date.now() + 10000};
      await fs.mkdir("/restore/destination", {mode: 0o700});
      const source = await openAgentBackupRestoreV3CandidateFs({trustedRoot: "/restore", attemptRoot: "/restore/attempt", control});
      const target = await openAgentBackupRestoreV3CandidateFs({trustedRoot: "/restore", attemptRoot: "/restore/destination", control});
      const sourceLock = await source.acquireLock(".copy.lock", control);
      const targetLock = await target.acquireLock(".copy.lock", control);
      try {
        await source.ensureFileTreeDirectory("input/empty", control, sourceLock);
        const writer = await source.createFileTreeFile("input", {path: "state.bin", sizeBytes: 300001, mode: 0o400, mtimeMs: 0}, undefined, control, sourceLock);
        await writer.write(new Uint8Array(262144).fill(91), control);
        await writer.write(new Uint8Array(37857).fill(91), control);
        await writer.finalize(control);
        const inventory = await source.inspectFileTree("input", control, sourceLock);
        const copied = await source.copyFileTreeFileTo(target, "input", inventory.entries[0], "generation", "state/state.bin", control, sourceLock, targetLock);
        const replay = await source.copyFileTreeFileTo(target, "input", inventory.entries[0], "generation", "state/state.bin", control, sourceLock, targetLock);
        const bytes = await fs.readFile("/restore/destination/generation/state/state.bin");
        const metadata = await fs.stat("/restore/destination/generation/state/state.bin");
        process.stdout.write(JSON.stringify({bytes: bytes.length, allBytesExact: bytes.every(byte => byte === 91), privateMode: metadata.mode & 511, links: metadata.nlink, distinctInodes: copied.inode !== inventory.entries[0].inode, exactReplay: JSON.stringify(copied) === JSON.stringify(replay), emptyDirectories: inventory.directoryPaths}));
      } finally {
        await targetLock.release(control);
        await sourceLock.release(control);
        await target.close();
        await source.close();
      }
    `,
      ),
    );
    expect(proof).toEqual({
      bytes: 300001,
      allBytesExact: true,
      privateMode: 0o400,
      links: 1,
      distinctInodes: true,
      exactReplay: true,
      emptyDirectories: ["empty"],
    });
  }, 30_000);

  it("materializes exact bytes through exec without inherited descriptors, network or runtime boot", async () => {
    const f = await fixture();
    const payload = new TextEncoder().encode(
      '{"name":"Docker restore QA","bio":["amber"],"plugins":[]}',
    );
    const record = {
      componentIndex: 0,
      componentName: "character" as const,
      dataIndex: 0,
      offsetBytes: 0,
      entry: null,
      payload,
    };
    const staged = await f.stage(record);
    const receipt: AgentBackupRestoreV3ComponentReceipt = {
      componentIndex: 0,
      componentName: "character",
      descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[0],
      dataFrameCount: 1,
      payloadBytes: payload.length,
      payloadSha256: staged.payloadSha256,
      recordStreamContentHmacSha256: "b".repeat(64),
    };
    expect(await f.exchange("finishComponent", receipt).result).toEqual({
      code: 0,
      stdout: materializerReceiptDigest(receipt),
      stderr: "",
    });
    expect(
      remote(
        f.id,
        'import fs from "node:fs/promises";process.stdout.write(await fs.readFile("/restore/attempt/components/character/character.json","utf8"));',
      ),
    ).toBe(new TextDecoder().decode(payload));
    expect(
      docker(
        "inspect",
        f.id,
        "--format",
        "{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}|{{.Path}}|{{.State.Running}}",
      ).trim(),
    ).toMatch(/^none\|(?:null|\{\})\|\/usr\/bin\/env\|true$/);
    expect(await f.stage(record)).toEqual(staged);
  }, 90_000);

  it("treats EOF after a complete frame as cancellation, not a request terminator", async () => {
    const f = await fixture();
    const record = snapshotAgentBackupRestoreV3CandidateRecord(
      {
        componentIndex: 0,
        componentName: "character",
        dataIndex: 0,
        offsetBytes: 0,
        entry: null,
        payload: new TextEncoder().encode('{"name":"Cancelled"}'),
      },
      control(),
    );
    try {
      const result = await f.exchange(
        "stageRecord",
        record.receipt,
        record.payload,
        true,
      ).result;
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(
        remote(
          f.id,
          'import fs from "node:fs/promises";process.stdout.write(JSON.stringify(await fs.readdir("/restore/attempt")));',
        ),
      ).toBe("[]");
    } finally {
      record.payload.fill(0);
    }
  }, 90_000);

  it.each(["stdin EOF", "client process loss"] as const)(
    "reaps a live native database-validation descendant on %s, then restores on exact retry",
    async (failure) => {
      const f = await fixture();
      const root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "restore-docker-source-"),
      );
      roots.add(root);
      const db = new PGlite(path.join(root, "source"));
      let payload: Uint8Array;
      try {
        await db.exec("CREATE TABLE docker_fact (value text NOT NULL)");
        await db.query("INSERT INTO docker_fact VALUES ($1)", [
          "amber docker lighthouse",
        ]);
        payload = new Uint8Array(
          await (await db.dumpDataDir("gzip")).arrayBuffer(),
        );
      } finally {
        await db.close();
      }
      await fs.rm(path.join(root, "source"), { recursive: true });
      let records = 0;
      try {
        for (let offset = 0; offset < payload.length; offset += 256 * 1024) {
          await f.stage({
            componentIndex: 1,
            componentName: "database",
            dataIndex: records++,
            offsetBytes: offset,
            entry: null,
            payload: payload.subarray(offset, offset + 256 * 1024),
          });
        }
        const receipt: AgentBackupRestoreV3ComponentReceipt = {
          componentIndex: 1,
          componentName: "database",
          descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[1],
          dataFrameCount: records,
          payloadBytes: payload.length,
          payloadSha256: hash(payload),
          recordStreamContentHmacSha256: "b".repeat(64),
        };
        const running = f.exchange("finishComponent", receipt);
        const scan = `import fs from "node:fs/promises"; const matches=[];
        for (const pid of await fs.readdir("/proc")) {if (!/^[0-9]+$/.test(pid)) continue;
          try {const args=(await fs.readFile("/proc/"+pid+"/cmdline","utf8")).split("\\0");
            if(args[1]===${JSON.stringify(validator)}) matches.push(pid);
          } catch(error) { // error-policy:J4 A process exiting during enumeration is visibly absent.
            if(error.code!=="ENOENT"&&error.code!=="ESRCH") throw error;}}
        process.stdout.write(JSON.stringify(matches));`;
        let descendants: string[] = [];
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !running.settled()) {
          descendants = JSON.parse(remote(f.id, scan));
          if (descendants.length) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        // Observe a real live validation PID before disconnect, not just a timer.
        expect(descendants.length).toBe(1);
        if (failure === "stdin EOF") running.disconnect();
        else running.loseClient();
        const cancelled = await running.result;
        expect(cancelled.code).not.toBe(0);
        expect(cancelled.stdout).toBe("");
        expect(cancelled.stderr).toBe("");
        // A killed Docker CLI cannot attest remote settlement through its exit.
        // Observe the remote worker and validator, not just the local client PID.
        const scanWorkers = scan.replace(
          JSON.stringify(validator),
          JSON.stringify(worker),
        );
        const cleanupDeadline = Date.now() + 10_000;
        let remainingWorkers: string[];
        do {
          remainingWorkers = JSON.parse(remote(f.id, scanWorkers));
          if (!remainingWorkers.length) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < cleanupDeadline);
        expect(remainingWorkers).toEqual([]);
        expect(JSON.parse(remote(f.id, scan))).toEqual([]);
        expect(
          remote(
            f.id,
            'import fs from "node:fs";process.stdout.write(String(fs.existsSync("/restore/attempt/.restore-v3-database-validation")));',
          ),
        ).toBe("false");
        expect(await f.exchange("finishComponent", receipt).result).toEqual({
          code: 0,
          stdout: materializerReceiptDigest(receipt),
          stderr: "",
        });
        expect(
          remote(
            f.id,
            'import fs from "node:fs/promises";import {PGlite} from "/repo/node_modules/@electric-sql/pglite/dist/index.js";await fs.cp("/restore/attempt/components/database","/restore/probe",{recursive:true});const db=new PGlite("/restore/probe");try{process.stdout.write(JSON.stringify((await db.query("SELECT value FROM docker_fact")).rows));}finally{await db.close();}',
          ),
        ).toBe('[{"value":"amber docker lighthouse"}]');
      } finally {
        payload.fill(0);
      }
    },
    120_000,
  );
});
