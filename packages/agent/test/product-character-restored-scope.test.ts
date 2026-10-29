/** A committed generation keeps its original profile scope despite its branded character. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createTestVault } from "@elizaos/auth/testing";
import {
  profileStorageKey,
  setEntryMeta,
  writeRoutingConfig,
} from "@elizaos/auth/vault";
import { AgentRuntime, stringToUuid } from "@elizaos/core";
import { expect, test, vi } from "vitest";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";
import { startEliza } from "../src/runtime/eliza.ts";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";
import { buildProductCharacterFromConfig } from "../src/runtime/prepare-product-character-config.ts";
import { openAgentBackupRestoreV3CandidateFs } from "../src/services/agent-backup-restore-v3-candidate-fs.ts";
import { candidateFsCanonicalJson } from "../src/services/agent-backup-restore-v3-candidate-fs-json.ts";
import type { AgentBackupRestoreV3PreparedGenerationReceipt } from "../src/services/agent-backup-restore-v3-generation.ts";
import { commitAgentBackupRestoreV3Generation } from "../src/services/agent-backup-restore-v3-generation-commit.ts";
import { AgentBackupRestoreV3RuntimeGeneration } from "../src/services/agent-backup-restore-v3-runtime-generation.ts";

test("actual restored generation retains branded character and original canonical vault scope", async () => {
  const environment = { ...process.env };
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "product-restore-"),
  );
  const attemptRoot = path.join(root, "private", "attempt"),
    runtimeRoot = path.join(root, "runtime");
  const control = () => ({
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + 120000,
  });
  const original = buildCharacterFromConfig({});
  if (!original.name) throw Error("Default character unavailable");
  const config = {
    agents: {
      list: [
        {
          id: "main",
          default: true,
          name: original.name,
          identityName: original.name,
        },
      ],
    },
  };
  const brand = { name: "Alpha", bio: ["Product biography"] };
  const character = buildProductCharacterFromConfig(config, brand);
  const agentId = character.id ?? stringToUuid(original.name);
  for (const dir of [
    path.join(attemptRoot, "generation/character"),
    path.join(attemptRoot, "generation/state"),
    runtimeRoot,
  ])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(attemptRoot, "generation/character/character.json"),
    JSON.stringify({ ...character, id: agentId }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(attemptRoot, "generation/state/eliza.json"),
    JSON.stringify(config),
    { mode: 0o600 },
  );
  const db = new PGlite(path.join(attemptRoot, "generation/database"));
  await db.exec("CREATE TABLE fixture_fact (value text)");
  await db.close();
  const tighten = async (dir: string): Promise<void> => {
    await fs.chmod(dir, 0o700);
    for (const entry of await fs.readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await tighten(path.join(dir, entry.name));
  };
  await tighten(path.join(attemptRoot, "generation/database"));
  const generationFs = await openAgentBackupRestoreV3CandidateFs({
    trustedRoot: path.join(root, "private"),
    attemptRoot,
    control: control(),
    testOnlyAllowNonLinuxFdEmulation: true,
  });
  let authority: AgentBackupRestoreV3RuntimeGeneration | undefined;
  let vault: Awaited<ReturnType<typeof createTestVault>> | undefined;
  try {
    const lock = await generationFs.acquireLock(
      ".restore-v3-generation.lock",
      control(),
    );
    let preparedReceipt: AgentBackupRestoreV3PreparedGenerationReceipt;
    try {
      const tree = await generationFs.inspectFileTree(
        "generation",
        control(),
        lock,
      );
      const body: Omit<
        AgentBackupRestoreV3PreparedGenerationReceipt,
        "receiptSha256"
      > = {
        version: 1,
        format: "elizaos.agent-backup.restore-v3-generation-prepared.v1",
        assemblySha256: "a".repeat(64),
        sourceTreeSha256: "b".repeat(64),
        targetRoot: generationFs.attemptRootIdentity,
        paths: {
          character: "generation/character/character.json",
          database: "generation/database",
          state: "generation/state",
        },
        treeSha256: tree.sha256,
        files: tree.files,
        directories: tree.directories,
        bytes: tree.bytes,
      };
      preparedReceipt = {
        ...body,
        receiptSha256: createHash("sha256")
          .update(candidateFsCanonicalJson(body))
          .digest("hex"),
      };
      await generationFs.publishDurableJson(
        ".restore-v3-generation-prepared.json",
        preparedReceipt,
        { maximumBytes: 16384 },
        control(),
        lock,
      );
    } finally {
      await lock.release(control());
    }
    const stat = await fs.stat(runtimeRoot, { bigint: true });
    const input = {
      generationFs,
      preparedReceipt,
      runtimeRoot,
      runtimeRootIdentity: {
        device: String(stat.dev),
        inode: String(stat.ino),
      },
      control: control(),
    };
    const committed = await commitAgentBackupRestoreV3Generation(input);
    authority = await AgentBackupRestoreV3RuntimeGeneration.open(
      { ...input, control: control() },
      agentId,
    );
    vi.stubEnv("ELIZA_STATE_DIR", committed.paths.state);
    vi.stubEnv(
      "ELIZA_CONFIG_PATH",
      path.join(committed.paths.state, "eliza.json"),
    );
    vi.stubEnv("PGLITE_DATA_DIR", committed.paths.database);
    vi.stubEnv("ELIZA_DISABLE_VAULT_PROFILE_RESOLVER", undefined);
    vault = await createTestVault({ workDir: committed.paths.state });
    const key = "ALPHA_QA_RESTORE_PROFILE_KEY",
      value = "synthetic-original";
    await vault.vault.set(profileStorageKey(key, "original"), value, {
      sensitive: true,
    });
    await vault.vault.set(profileStorageKey(key, "other"), "synthetic-other", {
      sensitive: true,
    });
    await setEntryMeta(vault.vault, key, {
      profiles: [
        { id: "original", label: "Original", createdAt: 1 },
        { id: "other", label: "Other", createdAt: 1 },
      ],
      activeProfile: "other",
    });
    await writeRoutingConfig(vault.vault, {
      rules: [
        {
          keyPattern: key,
          scope: {
            kind: "agent",
            agentId: original.name.toLowerCase().replace(/\s+/g, "-"),
          },
          profileId: "original",
        },
      ],
    });
    const ownedVault = vault.vault;
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      productCharacter: brand,
      sharedVault: () => ownedVault,
    });
    const model = vi
      .spyOn(AgentRuntime.prototype, "useModel")
      .mockImplementation(async () => {
        throw Error("No model in restore fixture");
      });
    const stop = new Error("Stop after restored constructor");
    let observed = false;
    await expect(
      startEliza({
        headless: true,
        configOverride: config,
        restoredGeneration: authority,
        onRuntimeCreated(runtime) {
          observed =
            runtime.agentId === agentId &&
            runtime.character.name === character.name &&
            process.env[key] === value;
          throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(observed).toBe(true);
    expect(authority.character().id).toBe(agentId);
    expect(authority.character().name).toBe(character.name);
    expect(model).not.toHaveBeenCalled();
  } finally {
    await vault?.dispose();
    await authority?.close();
    await generationFs.close();
    _resetAgentHostBridge();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env))
      if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await fs.rm(root, { recursive: true, force: true });
  }
});
