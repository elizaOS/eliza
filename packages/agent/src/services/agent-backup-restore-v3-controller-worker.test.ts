/**
 * Real process/filesystem tests of the private restore-v3 serving controller.
 * Each method runs in a spawned worker over the exact stdin frame contract.
 * The candidate is staged through the real record/assembly path; stream
 * authority receipts are fixture inputs, not provider cryptography. macOS uses
 * the explicitly test-only pathname emulation, not a Linux flock proof.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
  type AgentBackupRestoreV3CandidateReceipt,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3StagingSession,
} from "@elizaos/contracts";
import type {
  AgentBackupRestoreV3BootGrant,
  AgentBackupRestoreV3CommittedGeneration,
  AgentBackupRestoreV3ContainerRoots,
  AgentBackupRestoreV3RootIdentities,
} from "@elizaos/contracts/node";
import {
  AgentBackupRestoreV3ControllerResponseSchema,
  agentBackupRestoreV3TokenSha256,
  canonicalizeAgentBackupRestoreV3ServingValue,
} from "@elizaos/contracts/node";
import { afterEach, expect, it } from "vitest";
import { openAgentBackupRestoreV3CandidateFs } from "./agent-backup-restore-v3-candidate-fs";
import { stageAgentBackupRestoreV3CandidateRecord } from "./agent-backup-restore-v3-candidate-records";
import {
  consumeAgentBackupRestoreV3BootGrant,
  openAgentBackupRestoreV3GrantedGeneration,
} from "./agent-backup-restore-v3-restored-runtime-host";
import {
  encodeServingFrame,
  RESTORE_V3_BOOT_GRANT_FILE,
  resolveServingRoots,
} from "./agent-backup-restore-v3-serving-wire";

/** Test budgets are load tolerant; no case here proves deadline expiry. */
const BUDGET_MS = 10 * 60_000;
const worker = fileURLToPath(
  new URL("./agent-backup-restore-v3-controller-worker.ts", import.meta.url),
);
const dataRoots = new Set<string>();
const control = () => ({
  signal: new AbortController().signal,
  deadlineEpochMs: Date.now() + BUDGET_MS,
});
const emulate = process.platform !== "linux";
const fsOptions = () =>
  emulate ? { testOnlyAllowNonLinuxFdEmulation: true as const } : {};
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  for (const root of dataRoots)
    await fs.rm(root, { recursive: true, force: true });
  dataRoots.clear();
});

async function dataRoot(): Promise<string> {
  // Short real path keeps sibling unix-socket paths under the macOS limit.
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "r3c-"));
  dataRoots.add(root);
  await fs.chmod(root, 0o700);
  return root;
}

interface WorkerResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the real worker, keeping stdin open as the liveness channel. */
async function runController(
  root: string,
  request: unknown,
): Promise<WorkerResult> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx/esm"),
      worker,
      `--test-only-data-root=${root}`,
      ...(emulate ? ["--test-only-non-linux-fs"] : []),
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
    child.stdin.write(
      encodeServingFrame(canonicalizeAgentBackupRestoreV3ServingValue(request)),
    );
    const code = await closed;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
  }
}

function authority(agentId: string, restoreAttemptId: string) {
  return {
    version: 1 as const,
    agentId,
    restoreAttemptId,
    deadlineEpochMs: Date.now() + BUDGET_MS,
  };
}

async function prepareRoots(
  root: string,
  agentId: string,
  restoreAttemptId: string,
): Promise<AgentBackupRestoreV3RootIdentities> {
  const result = await runController(root, {
    ...authority(agentId, restoreAttemptId),
    method: "prepareRoots",
  });
  expect(result).toMatchObject({ code: 0, stderr: "" });
  const response = AgentBackupRestoreV3ControllerResponseSchema.parse(
    JSON.parse(result.stdout),
  );
  if (response.method !== "prepareRoots") throw new Error("Wrong response");
  expect(result.stdout).toBe(
    canonicalizeAgentBackupRestoreV3ServingValue(response),
  );
  return response.roots;
}

async function identity(target: string) {
  const stats = await fs.lstat(target, { bigint: true });
  return { device: String(stats.dev), inode: String(stats.ino) };
}

/** Stages a real five-component candidate into the attempt's private roots. */
async function stageCandidate(
  roots: AgentBackupRestoreV3ContainerRoots,
  agentId: string,
  restoreAttemptId: string,
) {
  const candidateFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: roots.trustedRoot,
    attemptRoot: roots.attemptRoot,
    control: control(),
    ...fsOptions(),
  });
  const session: AgentBackupRestoreV3StagingSession = Object.freeze({
    restoreAttemptId,
    operationId: randomUUID(),
    expectedManifestSha256: "a".repeat(64),
    stagingHandle: randomUUID(),
    cleanupHandle: randomUUID(),
    executionToken: randomUUID(),
    cleanupRegistered: true,
    isolatedCandidate: true,
  });
  const scratch = await fs.mkdtemp(
    path.join(path.dirname(roots.trustedRoot), "src-"),
  );
  const source = new PGlite(path.join(scratch, "db"));
  let databaseBytes: Uint8Array;
  try {
    await source.exec(
      "CREATE TABLE serving_fact (fact text NOT NULL); INSERT INTO serving_fact VALUES ('amber-20732')",
    );
    databaseBytes = new Uint8Array(
      await (await source.dumpDataDir("gzip")).arrayBuffer(),
    );
  } finally {
    await source.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
  const encode = (text: string) => new TextEncoder().encode(text);
  const contents = [
    encode(
      JSON.stringify({
        id: agentId,
        name: "Served Restore QA",
        bio: ["remembers an amber lighthouse"],
        plugins: [],
      }),
    ),
    databaseBytes,
    encode("private-media-20732"),
    encode('{"pluginFact":"tide-20732"}'),
    encode("opaque-vault-ciphertext-20732"),
  ];
  const paths = [null, null, "photo.bin", "plugin/state.json", "vault.json"];
  const components: AgentBackupRestoreV3ComponentReceipt[] = [];
  try {
    for (const [
      componentIndex,
      descriptor,
    ] of AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS.entries()) {
      const bytes = contents[componentIndex];
      if (!bytes) throw new Error("Missing fixture component");
      const filePath = paths[componentIndex];
      let dataFrameCount = 0;
      for (
        let offsetBytes = 0;
        offsetBytes < bytes.length;
        offsetBytes += 256 * 1024
      ) {
        const payload = Uint8Array.from(
          bytes.subarray(offsetBytes, offsetBytes + 256 * 1024),
        );
        await stageAgentBackupRestoreV3CandidateRecord({
          candidateFs,
          session,
          control: control(),
          record: {
            componentIndex,
            componentName: descriptor.name,
            dataIndex: dataFrameCount++,
            offsetBytes,
            payload,
            entry: filePath
              ? {
                  path: filePath,
                  fileOffsetBytes: offsetBytes,
                  fileSizeBytes: bytes.length,
                  mode: componentIndex === 4 ? 0o400 : 0o600,
                  mtimeMs: 0,
                }
              : null,
          },
        });
      }
      components.push({
        componentIndex,
        componentName: descriptor.name,
        descriptor,
        dataFrameCount,
        payloadBytes: bytes.length,
        payloadSha256: hash(bytes),
        recordStreamContentHmacSha256: "b".repeat(64),
      });
    }
  } finally {
    await candidateFs.close();
  }
  const receipt: AgentBackupRestoreV3CandidateReceipt = {
    format: AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
    restoreAttemptId,
    operationId: session.operationId,
    expectedManifestSha256: session.expectedManifestSha256,
    keyBundleGenerationId: randomUUID(),
    sourceCopyRole: "primary",
    sourceAuthorityDerivation:
      AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    sourceAuthoritySha256: "c".repeat(64),
    objectCount: 5,
    stagedPayloadBytes: components.reduce((n, c) => n + c.payloadBytes, 0),
    stagedDataRecordCount: components.reduce((n, c) => n + c.dataFrameCount, 0),
    sourceObjects: components.map((c) => ({
      componentIndex: c.componentIndex,
      componentName: c.componentName,
      chunkIndex: 0,
      copyRole: "primary",
      objectId: randomUUID(),
      exactReadReceiptDerivation:
        AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
      exactReadReceiptSha256: "d".repeat(64),
      ciphertextSha256: "e".repeat(64),
      sizeBytes: c.payloadBytes,
    })),
    components,
    authorityRevalidated: true,
  };
  return { session, receipt };
}

function bootGrant(
  agentId: string,
  restoreAttemptId: string,
  generation: AgentBackupRestoreV3CommittedGeneration,
): AgentBackupRestoreV3BootGrant {
  const token = randomBytes(32).toString("base64url");
  return {
    version: 1,
    format: "elizaos.agent-backup.restore-v3-boot-grant.v1",
    agentId,
    organizationId: randomUUID(),
    restoreAttemptId,
    containerId: randomBytes(32).toString("hex"),
    nodeIncarnation: randomUUID(),
    generation,
    token,
    tokenSha256: agentBackupRestoreV3TokenSha256(token),
  };
}

it(
  "prepares private roots idempotently and rejects symlinked or widened roots",
  async () => {
    const root = await dataRoot();
    const agentId = randomUUID();
    const restoreAttemptId = randomUUID();
    const roots = resolveServingRoots(restoreAttemptId, root);
    const first = await prepareRoots(root, agentId, restoreAttemptId);
    expect(first).toEqual({
      trustedRootIdentity: await identity(roots.trustedRoot),
      attemptRootIdentity: await identity(roots.attemptRoot),
      generationTrustedRootIdentity: await identity(
        roots.generationTrustedRoot,
      ),
      generationRootIdentity: await identity(roots.generationRoot),
      runtimeRootIdentity: await identity(roots.runtimeRoot),
    });
    for (const directory of Object.values(roots))
      expect((await fs.lstat(directory)).mode & 0o7777).toBe(0o700);
    expect(await prepareRoots(root, agentId, restoreAttemptId)).toEqual(first);

    // A root that became group-readable is refused, never silently tightened.
    await fs.chmod(roots.trustedRoot, 0o750);
    const widened = await runController(root, {
      ...authority(agentId, restoreAttemptId),
      method: "prepareRoots",
    });
    expect(widened).toEqual({ code: 1, stdout: "", stderr: "" });
    expect((await fs.lstat(roots.trustedRoot)).mode & 0o7777).toBe(0o750);

    const otherAttempt = randomUUID();
    const otherRoots = resolveServingRoots(otherAttempt, root);
    const decoy = path.join(root, "decoy");
    await fs.mkdir(decoy, { mode: 0o700 });
    await fs.mkdir(path.dirname(otherRoots.runtimeRoot), { recursive: true });
    await fs.symlink(decoy, otherRoots.runtimeRoot);
    const symlinked = await runController(root, {
      ...authority(agentId, otherAttempt),
      method: "prepareRoots",
    });
    expect(symlinked).toEqual({ code: 1, stdout: "", stderr: "" });
    expect(await fs.readdir(decoy)).toEqual([]);
  },
  BUDGET_MS,
);

it(
  "commits the sealed candidate, replays the lost response, and hands off one boot grant",
  async () => {
    const root = await dataRoot();
    const agentId = randomUUID();
    const restoreAttemptId = randomUUID();
    const roots = resolveServingRoots(restoreAttemptId, root);
    const identities = await prepareRoots(root, agentId, restoreAttemptId);
    const { session, receipt } = await stageCandidate(
      roots,
      agentId,
      restoreAttemptId,
    );
    const commitRequest = {
      ...authority(agentId, restoreAttemptId),
      method: "commitGeneration",
      roots: identities,
      session,
      receipt,
    };
    const committed = await runController(root, commitRequest);
    expect(committed).toMatchObject({ code: 0, stderr: "" });
    const response = AgentBackupRestoreV3ControllerResponseSchema.parse(
      JSON.parse(committed.stdout),
    );
    if (response.method !== "commitGeneration") throw new Error("Wrong method");
    const generation = response.generation;
    expect(generation.runtimeRootIdentity).toEqual(
      identities.runtimeRootIdentity,
    );
    expect(generation.generationRootIdentity).toEqual(
      identities.generationRootIdentity,
    );
    expect(generation.preparedReceipt.receiptSha256).toBe(
      generation.preparedReceiptSha256,
    );
    const promoted = path.join(
      roots.runtimeRoot,
      `generation-${generation.preparedReceiptSha256}`,
    );
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(promoted, "character/character.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ id: agentId, name: "Served Restore QA" });
    const characterInode = (
      await fs.stat(path.join(promoted, "character/character.json"), {
        bigint: true,
      })
    ).ino;

    // The coordinator lost the response: the retry returns the identical handoff
    // from the durable prepared/committed receipts without rewriting the layout.
    const replay = await runController(root, {
      ...commitRequest,
      deadlineEpochMs: Date.now() + BUDGET_MS,
    });
    expect(replay).toEqual(committed);
    expect(
      (
        await fs.stat(path.join(promoted, "character/character.json"), {
          bigint: true,
        })
      ).ino,
    ).toBe(characterInode);

    // A different candidate session cannot claim the committed generation.
    const foreign = await runController(root, {
      ...commitRequest,
      deadlineEpochMs: Date.now() + BUDGET_MS,
      session: { ...session, executionToken: randomUUID() },
    });
    expect(foreign).toEqual({ code: 1, stdout: "", stderr: "" });

    const grant = bootGrant(agentId, restoreAttemptId, generation);
    const tampered = await runController(root, {
      ...authority(agentId, restoreAttemptId),
      method: "writeBootGrant",
      grant: { ...grant, tokenSha256: "0".repeat(64) },
    });
    expect(tampered).toEqual({ code: 1, stdout: "", stderr: "" });
    await expect(
      fs.access(path.join(roots.runtimeRoot, RESTORE_V3_BOOT_GRANT_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const grantRequest = {
      ...authority(agentId, restoreAttemptId),
      method: "writeBootGrant",
      grant,
    };
    const written = await runController(root, grantRequest);
    const grantSha256 = createHash("sha256")
      .update(canonicalizeAgentBackupRestoreV3ServingValue(grant))
      .digest("hex");
    expect(written).toEqual({
      code: 0,
      stdout: canonicalizeAgentBackupRestoreV3ServingValue({
        method: "writeBootGrant",
        grantSha256,
      }),
      stderr: "",
    });
    const grantFile = path.join(roots.runtimeRoot, RESTORE_V3_BOOT_GRANT_FILE);
    expect((await fs.lstat(grantFile)).mode & 0o7777).toBe(0o600);
    expect(await fs.readFile(grantFile, "utf8")).toBe(
      canonicalizeAgentBackupRestoreV3ServingValue(grant),
    );
    expect(
      await runController(root, {
        ...grantRequest,
        deadlineEpochMs: Date.now() + BUDGET_MS,
      }),
    ).toEqual(written);
    const regrant = bootGrant(agentId, restoreAttemptId, generation);
    expect(
      await runController(root, {
        ...authority(agentId, restoreAttemptId),
        method: "writeBootGrant",
        grant: regrant,
      }),
    ).toEqual({ code: 1, stdout: "", stderr: "" });

    // The booting runtime consumes the grant exactly once and reopens the
    // committed generation from the handoff identities alone.
    const consumed = await consumeAgentBackupRestoreV3BootGrant(
      roots.runtimeRoot,
      restoreAttemptId,
    );
    try {
      expect(consumed.grantSha256).toBe(grantSha256);
      expect(consumed.token.toString("utf8")).toBe(grant.token);
      expect(consumed.grant).not.toHaveProperty("token");
      await expect(fs.access(grantFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        consumeAgentBackupRestoreV3BootGrant(
          roots.runtimeRoot,
          restoreAttemptId,
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_SERVING_GRANT_MISSING",
      });
      const opened = await openAgentBackupRestoreV3GrantedGeneration({
        roots,
        grant: consumed.grant,
        control: control(),
        testOnlyAllowNonLinuxFdEmulation: emulate,
      });
      try {
        expect(opened.receipt.receiptSha256).toBe(
          generation.committedReceiptSha256,
        );
        expect(opened.character()).toMatchObject({
          id: agentId,
          name: "Served Restore QA",
        });
      } finally {
        await opened.close();
      }
    } finally {
      consumed.token.fill(0);
    }
    // A consumed grant replays to its digest but is never rewritten or replaced.
    expect(
      await runController(root, {
        ...grantRequest,
        deadlineEpochMs: Date.now() + BUDGET_MS,
      }),
    ).toEqual(written);
    await expect(fs.access(grantFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await runController(root, {
        ...authority(agentId, restoreAttemptId),
        method: "writeBootGrant",
        grant: regrant,
      }),
    ).toEqual({ code: 1, stdout: "", stderr: "" });
  },
  BUDGET_MS,
);

it(
  "rejects an expired deadline and a mismatched grant identity before any effect",
  async () => {
    const root = await dataRoot();
    const agentId = randomUUID();
    const restoreAttemptId = randomUUID();
    const expired = await runController(root, {
      ...authority(agentId, restoreAttemptId),
      deadlineEpochMs: Date.now() - 1,
      method: "prepareRoots",
    });
    expect(expired).toEqual({ code: 1, stdout: "", stderr: "" });
    expect(await fs.readdir(root)).toEqual([]);
    const identities = await prepareRoots(root, agentId, restoreAttemptId);
    const generation: AgentBackupRestoreV3CommittedGeneration = {
      preparedReceipt: {},
      preparedReceiptSha256: "a".repeat(64),
      committedReceiptSha256: "b".repeat(64),
      runtimeRootIdentity: identities.runtimeRootIdentity,
      generationTrustedRootIdentity: identities.generationTrustedRootIdentity,
      generationRootIdentity: identities.generationRootIdentity,
    };
    const mismatched = await runController(root, {
      ...authority(agentId, restoreAttemptId),
      method: "writeBootGrant",
      grant: bootGrant(randomUUID(), restoreAttemptId, generation),
    });
    expect(mismatched).toEqual({ code: 1, stdout: "", stderr: "" });
    expect(
      await fs.readdir(resolveServingRoots(restoreAttemptId, root).runtimeRoot),
    ).toEqual([]);
  },
  BUDGET_MS,
);
