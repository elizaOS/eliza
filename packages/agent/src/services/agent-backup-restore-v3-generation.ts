/**
 * Prepares a replayable runtime layout from an assembled manifest-v3 candidate.
 * Both filesystem authorities remain private quarantines: the durable layout
 * receipt authorizes neither promotion to a live directory nor Agent boot.
 * State, vault and media share the runtime's state root; the physical database
 * and character remain separately addressable by a subsequent exact bootstrap.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { parseAgentBackupRestoreV3CandidateReceipt } from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateAssemblyInput,
  assembleAgentBackupRestoreV3Candidate,
} from "./agent-backup-restore-v3-candidate-assembly";
import {
  type AgentBackupRestoreV3CandidateFs,
  type AgentBackupRestoreV3CandidateFsIdentity,
  type AgentBackupRestoreV3CandidateFsLock,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import {
  internalCleanupControl,
  runAllBoundedInternalCleanup,
  snapshotOperationControl,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import { snapshotAgentBackupRestoreV3CandidateSession } from "./agent-backup-restore-v3-candidate-records";

const MARKER = ".restore-v3-generation-prepared.json";
const MARKER_LIMIT = 16 * 1024;
const ROOT = "generation";
const PATHS = Object.freeze({
  character: "generation/character/character.json",
  database: "generation/database",
  state: "generation/state",
});

export interface AgentBackupRestoreV3PreparedGenerationReceipt {
  readonly version: 1;
  readonly format: "elizaos.agent-backup.restore-v3-generation-prepared.v1";
  readonly assemblySha256: string;
  readonly sourceTreeSha256: string;
  readonly targetRoot: Readonly<AgentBackupRestoreV3CandidateFsIdentity>;
  readonly paths: typeof PATHS;
  readonly treeSha256: string;
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
  readonly receiptSha256: string;
}

function fail(code: string): never {
  throw new ElizaError("Restore generation layout is not proven", {
    code: `AGENT_BACKUP_RESTORE_V3_GENERATION_${code}`,
  });
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(candidateFsCanonicalJson(value))
    .digest("hex");
}
function nested(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function within(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}
function layoutPath(source: string, directory: boolean): string {
  const [component, ...segments] = source.split("/");
  const suffix = segments.join("/");
  let root: string;
  switch (component) {
    case "character":
      root = "character";
      break;
    case "database":
      root = "database";
      break;
    case "media":
      root = "state/media";
      break;
    case "state-files":
      if (
        ["media", ".vault-pglite", "vault.json", "audit/vault.jsonl"].some(
          (reserved) => within(suffix, reserved),
        )
      )
        fail("COMPONENT_COLLISION");
      root = "state";
      break;
    case "vault":
      if (
        suffix &&
        !within(suffix, ".vault-pglite") &&
        suffix !== "vault.json" &&
        suffix !== "audit/vault.jsonl" &&
        !(directory && suffix === "audit")
      )
        fail("VAULT_PATH_INVALID");
      root = "state";
      break;
    default:
      fail("COMPONENT_INVALID");
  }
  return suffix ? `${root}/${suffix}` : root;
}

export async function prepareAgentBackupRestoreV3Generation(
  input: Readonly<
    AgentBackupRestoreV3CandidateAssemblyInput & {
      readonly generationFs: AgentBackupRestoreV3CandidateFs;
    }
  >,
): Promise<Readonly<AgentBackupRestoreV3PreparedGenerationReceipt>> {
  const keys = ["candidateFs", "generationFs", "session", "receipt", "control"];
  const exact = snapshotOwnDataRecord(
    input,
    keys,
    keys,
    "AGENT_BACKUP_RESTORE_V3_GENERATION_INPUT_INVALID",
    "Generation preparation requires exact data properties",
  );
  const source = exact.candidateFs;
  const target = exact.generationFs;
  if (
    !isAgentBackupRestoreV3CandidateFs(source) ||
    !isAgentBackupRestoreV3CandidateFs(target)
  )
    fail("INPUT_INVALID");
  if (
    nested(source.attemptRoot, target.attemptRoot) ||
    nested(target.attemptRoot, source.attemptRoot) ||
    (source.attemptRootIdentity.device === target.attemptRootIdentity.device &&
      source.attemptRootIdentity.inode === target.attemptRootIdentity.inode)
  )
    fail("ROOT_OVERLAP");
  const control = snapshotOperationControl(
    exact.control as AgentBackupRestoreV3CandidateAssemblyInput["control"],
  );
  const session = snapshotAgentBackupRestoreV3CandidateSession(
    exact.session as AgentBackupRestoreV3CandidateAssemblyInput["session"],
  );
  const receipt = parseAgentBackupRestoreV3CandidateReceipt(
    JSON.parse(candidateFsCanonicalJson(exact.receipt)),
  );
  const assemblyInput = { candidateFs: source, session, receipt, control };
  // A stable lock order prevents reverse source/destination calls deadlocking.
  const authorities = [source, target].sort((a, b) =>
    a.attemptRoot < b.attemptRoot ? -1 : 1,
  );
  const locks = new Map<
    AgentBackupRestoreV3CandidateFs,
    AgentBackupRestoreV3CandidateFsLock
  >();
  try {
    for (const authority of authorities)
      locks.set(
        authority,
        await authority.acquireLock(".restore-v3-generation.lock", control),
      );
    const sourceLock = locks.get(source);
    const targetLock = locks.get(target);
    if (!sourceLock || !targetLock) fail("LOCK_MISSING");
    const assembly = await assembleAgentBackupRestoreV3Candidate(
      assemblyInput,
      sourceLock,
    );
    const inventory = await source.inspectFileTree(
      "components",
      control,
      sourceLock,
    );
    const files = inventory.entries.map((file) => ({
      file,
      target: layoutPath(file.path, false),
    }));
    const directories = new Set(
      inventory.directoryPaths.map((directory) => layoutPath(directory, true)),
    );
    const names = new Set<string>();
    for (const file of files) {
      if (names.has(file.target) || directories.has(file.target))
        fail("COMPONENT_COLLISION");
      names.add(file.target);
    }
    if (
      !names.has("database/PG_VERSION") ||
      !names.has("character/character.json")
    )
      fail("REQUIRED_FILE_MISSING");
    const authority = {
      version: 1 as const,
      format: "elizaos.agent-backup.restore-v3-generation-prepared.v1" as const,
      assemblySha256: assembly.assemblySha256,
      sourceTreeSha256: inventory.sha256,
      targetRoot: target.attemptRootIdentity,
      paths: PATHS,
    };
    const previous = await target.readDurableJson(
      MARKER,
      { maximumBytes: MARKER_LIMIT },
      control,
      targetLock,
    );
    if (previous !== null) {
      const output = await target.inspectFileTree(ROOT, control, targetLock);
      const body = {
        ...authority,
        treeSha256: output.sha256,
        files: output.files,
        directories: output.directories,
        bytes: output.bytes,
      };
      const expected = { ...body, receiptSha256: digest(body) };
      if (
        candidateFsCanonicalJson(previous) !==
        candidateFsCanonicalJson(expected)
      )
        fail("REPLAY_CONFLICT");
      return Object.freeze(expected);
    }
    await target.ensureFileTreeDirectory(ROOT, control, targetLock);
    for (const directory of directories)
      await target.ensureFileTreeDirectory(
        `${ROOT}/${directory}`,
        control,
        targetLock,
      );
    const copied = [];
    for (const file of files)
      copied.push(
        await source.copyFileTreeFileTo(
          target,
          "components",
          file.file,
          ROOT,
          file.target,
          control,
          sourceLock,
          targetLock,
        ),
      );
    const output = await target.inspectFileTree(ROOT, control, targetLock);
    // Full inventory equality rejects stale or injected output even if every expected file copied successfully.
    const byPath = (a: { path: string }, b: { path: string }) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    if (
      candidateFsCanonicalJson([...output.entries].sort(byPath)) !==
        candidateFsCanonicalJson(copied.sort(byPath)) ||
      candidateFsCanonicalJson([...output.directoryPaths].sort()) !==
        candidateFsCanonicalJson([...directories].sort())
    )
      fail("OUTPUT_CONFLICT");
    const revalidated = await assembleAgentBackupRestoreV3Candidate(
      assemblyInput,
      sourceLock,
    );
    if (
      revalidated.assemblySha256 !== assembly.assemblySha256 ||
      (await source.inspectFileTree("components", control, sourceLock))
        .sha256 !== inventory.sha256
    )
      fail("SOURCE_CHANGED");
    const body = {
      ...authority,
      treeSha256: output.sha256,
      files: output.files,
      directories: output.directories,
      bytes: output.bytes,
    };
    const result = Object.freeze({ ...body, receiptSha256: digest(body) });
    await target.publishDurableJson(
      MARKER,
      result,
      { maximumBytes: MARKER_LIMIT },
      control,
      targetLock,
    );
    if (
      candidateFsCanonicalJson(
        await target.readDurableJson(
          MARKER,
          { maximumBytes: MARKER_LIMIT },
          control,
          targetLock,
        ),
      ) !== candidateFsCanonicalJson(result)
    )
      fail("RECEIPT_CHANGED");
    return result;
  } finally {
    await runAllBoundedInternalCleanup(
      [...locks.values()]
        .reverse()
        .map((lock) => () => lock.release(internalCleanupControl())),
    );
  }
}
