/**
 * Binds runtime startup to an already committed restore generation.
 * The controller opens this authority before starting a dedicated Agent process;
 * its private journal and runtime parent must remain outside workload access.
 * It rejects missing physical database files and conflicting startup paths, but
 * does not authorize routing or replace the coordinator's signed boot grant.
 */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type Character,
  ElizaError,
  parseAndValidateCharacter,
  resolveAliasedEnvValue,
  resolveStateDir,
} from "@elizaos/core";
import type { ElizaConfig } from "../config/config";
import {
  type CandidateFsDirectoryAuthority,
  controlled,
  controlledAcquire,
  fileStatExact,
  internalCleanupControl,
  lstatExact,
  resolveDirectoryAuthority,
  runAllBoundedInternalCleanup,
  sameIdentity,
  sameStableFile,
  snapshotOperationControl,
} from "./agent-backup-restore-v3-candidate-fs-control";
import {
  type AgentBackupRestoreV3CommittedGenerationReceipt,
  type AgentBackupRestoreV3GenerationCommitInput,
  verifyAgentBackupRestoreV3GenerationCommit,
} from "./agent-backup-restore-v3-generation-commit";

const instances = new WeakSet<object>();
const constructionAuthority = Symbol("restore-runtime-generation");
function fail(code: string): never {
  throw new ElizaError("Restored runtime startup authority is not proven", {
    code: `AGENT_BACKUP_RESTORE_V3_BOOT_${code}`,
    severity: "fatal",
  });
}

async function readFile(
  authority: CandidateFsDirectoryAuthority,
  name: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const control = internalCleanupControl();
  const target = path.join(authority.anchor, name);
  const handle = await controlledAcquire(
    () =>
      fs.open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ),
    (late) => late.close(),
    control,
  );
  let bytes: Uint8Array | undefined;
  let closed = false;
  try {
    const before = await fileStatExact(handle);
    if (
      !before.file ||
      before.linkCount !== 1 ||
      before.size <= 0 ||
      before.size > maximumBytes ||
      !sameIdentity(before, await lstatExact(target))
    )
      fail("FILE_INVALID");
    bytes = new Uint8Array(before.size);
    const ownedBytes = bytes;
    let offset = 0;
    while (offset < bytes.length) {
      const result = await controlled(
        () =>
          handle.read(ownedBytes, offset, ownedBytes.length - offset, offset),
        control,
      );
      if (result.bytesRead === 0) fail("FILE_CHANGED");
      offset += result.bytesRead;
    }
    if (
      !sameStableFile(before, await fileStatExact(handle)) ||
      !sameStableFile(before, await lstatExact(target))
    )
      fail("FILE_CHANGED");
    const result = bytes;
    await handle.close();
    closed = true;
    bytes = undefined;
    return result;
  } finally {
    bytes?.fill(0);
    if (!closed) await handle.close();
  }
}

export class AgentBackupRestoreV3RuntimeGeneration {
  readonly receipt: AgentBackupRestoreV3CommittedGenerationReceipt;
  readonly #directories: readonly CandidateFsDirectoryAuthority[];
  readonly #character: Character;
  #closed = false;

  private constructor(
    token: symbol,
    receipt: AgentBackupRestoreV3CommittedGenerationReceipt,
    directories: readonly CandidateFsDirectoryAuthority[],
    character: Character,
  ) {
    if (token !== constructionAuthority) fail("INPUT_INVALID");
    this.receipt = receipt;
    this.#directories = directories;
    this.#character = structuredClone(character);
    instances.add(this);
    Object.freeze(this);
  }

  static async open(
    input: Readonly<AgentBackupRestoreV3GenerationCommitInput>,
    expectedAgentId: string,
  ): Promise<AgentBackupRestoreV3RuntimeGeneration> {
    const control = snapshotOperationControl(input.control);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        expectedAgentId,
      )
    )
      fail("IDENTITY_INVALID");
    const receipt = await verifyAgentBackupRestoreV3GenerationCommit(input);
    const directories: CandidateFsDirectoryAuthority[] = [];
    try {
      for (const directory of [
        receipt.runtimeRoot,
        path.dirname(receipt.paths.state),
        path.dirname(receipt.paths.character),
        receipt.paths.database,
        path.join(receipt.paths.database, "global"),
        receipt.paths.state,
      ]) {
        directories.push(
          await resolveDirectoryAuthority(
            directory,
            "committed runtime directory",
            control,
            process.platform !== "linux" && process.env.NODE_ENV === "test",
          ),
        );
      }
      const parent = directories[0];
      const generation = directories[1];
      if (
        String(parent.stats.device) !== receipt.runtimeRootIdentity.device ||
        String(parent.stats.inode) !== receipt.runtimeRootIdentity.inode ||
        String(generation.stats.device) !== receipt.generationIdentity.device ||
        String(generation.stats.inode) !== receipt.generationIdentity.inode
      )
        fail("IDENTITY_CHANGED");
      const bytes = await readFile(
        directories[2],
        "character.json",
        16 * 1024 * 1024,
      );
      let character: Character;
      try {
        const validation = parseAndValidateCharacter(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (
          !validation.success ||
          !validation.data ||
          validation.data.id !== expectedAgentId
        )
          fail("CHARACTER_INVALID");
        character = validation.data;
      } finally {
        bytes.fill(0);
      }
      const authority = new AgentBackupRestoreV3RuntimeGeneration(
        constructionAuthority,
        receipt,
        directories,
        character,
      );
      await authority.assertFiles();
      return authority;
    } catch (cause) {
      // error-policy:J2 Close every descriptor when startup validation fails.
      await runAllBoundedInternalCleanup(
        directories
          .reverse()
          .map((directory) => () => directory.handle.close()),
      );
      throw cause;
    }
  }

  character(): Character {
    if (this.#closed) fail("CLOSED");
    return structuredClone(this.#character);
  }

  configure(config: ElizaConfig): void {
    this.assertEnvironment();
    for (const values of [config.env, config.env?.vars]) {
      if (!values) continue;
      for (const [key, value] of Object.entries(values)) {
        if (
          (key === "ELIZA_STATE_DIR" && value !== this.receipt.paths.state) ||
          (key === "PGLITE_DATA_DIR" &&
            value !== this.receipt.paths.database) ||
          ([
            "POSTGRES_URL",
            "DATABASE_URL",
            "ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS",
          ].includes(key) &&
            value)
        )
          fail("CONFIG_CONFLICT");
      }
    }
    if (
      (config.database?.provider && config.database.provider !== "pglite") ||
      (config.database?.pglite?.dataDir &&
        config.database.pglite.dataDir !== this.receipt.paths.database)
    )
      fail("DATABASE_CONFLICT");
    config.database = {
      provider: "pglite",
      pglite: { dataDir: this.receipt.paths.database },
    };
  }

  assertEnvironment(): void {
    if (this.#closed) fail("CLOSED");
    if (
      ["1", "true", "on", "yes"].includes(
        process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS?.trim().toLowerCase() ??
          "",
      )
    )
      fail("DESTRUCTIVE_MIGRATION_FORBIDDEN");
    if (
      resolveStateDir() !== this.receipt.paths.state ||
      resolveAliasedEnvValue("ELIZA_STATE_DIR") !== this.receipt.paths.state
    )
      fail("STATE_CONFLICT");
    if (
      process.env.POSTGRES_URL ||
      process.env.DATABASE_URL ||
      (process.env.PGLITE_DATA_DIR &&
        process.env.PGLITE_DATA_DIR !== this.receipt.paths.database)
    )
      fail("DATABASE_CONFLICT");
    if (
      process.env.SANDBOX_ROUTE_AGENT_ID &&
      process.env.SANDBOX_ROUTE_AGENT_ID !== this.#character.id
    )
      fail("IDENTITY_CONFLICT");
  }

  async assertFiles(): Promise<void> {
    if (this.#closed) fail("CLOSED");
    for (const authority of this.#directories) {
      const [opened, visible, real] = await Promise.all([
        fileStatExact(authority.handle),
        lstatExact(authority.path),
        fs.realpath(authority.path),
      ]);
      if (
        real !== authority.path ||
        !sameIdentity(opened, authority.stats) ||
        !sameIdentity(opened, visible) ||
        !opened.directory ||
        (opened.mode & 0o7077) !== 0
      )
        fail("DIRECTORY_CHANGED");
    }
    const version = await readFile(this.#directories[3], "PG_VERSION", 32);
    try {
      const pgControl = await readFile(
        this.#directories[4],
        "pg_control",
        1024 * 1024,
      );
      pgControl.fill(0);
      if (!/^[1-9][0-9]*\n?$/.test(new TextDecoder().decode(version)))
        fail("DATABASE_INVALID");
    } finally {
      version.fill(0);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await runAllBoundedInternalCleanup(
      [...this.#directories]
        .reverse()
        .map((directory) => () => directory.handle.close()),
    );
  }
}

Object.freeze(AgentBackupRestoreV3RuntimeGeneration.prototype);
export function isAgentBackupRestoreV3RuntimeGeneration(
  value: unknown,
): value is AgentBackupRestoreV3RuntimeGeneration {
  return typeof value === "object" && value !== null && instances.has(value);
}
