import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ChannelType,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const evidenceDir = path.join(repoRoot, ".github", "issue-evidence");
const stateDir = path.join(evidenceDir, "9963-live-restore-state");
const pgliteDir = path.join(stateDir, "pglite");
const summaryPath = path.join(
  evidenceDir,
  "9963-live-restore-prep-summary.json",
);
const scenarioId = "backup.restore-recall";
const phrase = "silver comet orchid";
const roomId = stringToUuid(`scenario-room:${scenarioId}:main`);
const userId = stringToUuid(`scenario-account:${scenarioId}:main`);
const worldId = stringToUuid(`scenario-runner-world:${scenarioId}`);

function applyEvidenceEnv(localRootKey: string): void {
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_SCENARIO_PGLITE_DIR = pgliteDir;
  process.env.ELIZA_SAVE_TRAJECTORIES = "1";
  process.env.ELIZA_KMS_BACKEND = "local";
  process.env.ELIZA_LOCAL_MODE = "1";
  process.env.ELIZA_LOCAL_ROOT_KEY = localRootKey;
  delete process.env.SCENARIO_USE_LLM_PROXY;
  delete process.env.ELIZA_SCENARIO_USE_LLM_PROXY;
}

interface RuntimeLike {
  agentId: UUID;
  ensureConnection: (params: {
    entityId: UUID;
    roomId: UUID;
    worldId: UUID;
    userName: string;
    source: string;
    channelId: UUID;
    type: ChannelType;
  }) => Promise<unknown>;
  createMemory: (
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ) => Promise<unknown>;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function seedDomainFiles(): Promise<Record<string, string>> {
  const mediaBytes = Buffer.from(
    "restored media bytes for #9963 live backup evidence\n",
    "utf8",
  );
  const mediaName = `${sha256(mediaBytes)}.txt`;
  const mediaPath = path.join(stateDir, "media", mediaName);
  await fs.mkdir(path.dirname(mediaPath), { recursive: true });
  await fs.writeFile(mediaPath, mediaBytes);

  await fs.mkdir(path.join(stateDir, ".vault-pglite"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "audit"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "vault.json"),
    JSON.stringify({ encrypted: "ciphertext-for-live-restore-evidence" }),
  );
  await fs.writeFile(
    path.join(stateDir, ".vault-pglite", "data.bin"),
    "vault-pglite-ciphertext\n",
  );
  await fs.writeFile(
    path.join(stateDir, "audit", "vault.jsonl"),
    '{"event":"backup-evidence"}\n',
  );

  return {
    mediaName,
    mediaSha256: sha256(mediaBytes),
  };
}

async function ensureScenarioConnection(runtime: RuntimeLike): Promise<void> {
  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "ScenarioUser",
    source: "dashboard",
    channelId: roomId,
    type: ChannelType.DM,
  });
}

async function seedRestoredFact(runtime: RuntimeLike): Promise<void> {
  await ensureScenarioConnection(runtime);
  const createdAt = Date.parse("2026-06-30T06:00:00.000Z");
  const base = {
    agentId: runtime.agentId,
    roomId,
    worldId,
    createdAt,
  };
  const factMemory: Memory = {
    ...base,
    id: crypto.randomUUID() as UUID,
    entityId: userId,
    content: {
      text: `The user's backup recall phrase is exactly: ${phrase}.`,
      source: "backup-restore-evidence",
    },
  };
  const messageMemory: Memory = {
    ...base,
    id: crypto.randomUUID() as UUID,
    entityId: userId,
    content: {
      text: `Please remember this backup recall phrase for restore validation: ${phrase}.`,
      source: "backup-restore-evidence",
      channelType: ChannelType.DM,
    },
  };
  await runtime.createMemory(factMemory, "facts", true);
  await runtime.createMemory(messageMemory, "messages", true);
}

async function wipeRestoredComponents(): Promise<void> {
  await fs.rm(pgliteDir, { recursive: true, force: true });
  await fs.rm(path.join(stateDir, "media"), { recursive: true, force: true });
  await fs.rm(path.join(stateDir, ".vault-pglite"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(stateDir, "audit"), { recursive: true, force: true });
  await fs.rm(path.join(stateDir, "vault.json"), { force: true });
}

async function main(): Promise<void> {
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  const localRootKey = crypto.randomBytes(32).toString("base64");
  applyEvidenceEnv(localRootKey);

  const [
    { createScenarioRuntime },
    { createLocalAgentBackup, restoreLocalAgentBackup },
    { resolveStateDir },
  ] = await Promise.all([
    import("../../packages/scenario-runner/src/runtime-factory.ts"),
    import("../../packages/agent/src/services/agent-backup.ts"),
    import("@elizaos/core"),
  ]);

  const source = await createScenarioRuntime();
  let backup;
  let seeded;
  let resolvedStateDirBeforeBackup;
  const sourceAgentId = source.runtime.agentId;
  try {
    applyEvidenceEnv(localRootKey);
    seeded = await seedDomainFiles();
    await seedRestoredFact(source.runtime);
    resolvedStateDirBeforeBackup = resolveStateDir();
    backup = await createLocalAgentBackup(source.runtime, {
      agents: { defaults: { workspace: "backup-restore-live-evidence" } },
    } as never);
  } finally {
    await source.cleanup();
  }
  applyEvidenceEnv(localRootKey);

  await wipeRestoredComponents();
  applyEvidenceEnv(localRootKey);

  const restore = await createScenarioRuntime();
  const restoreAgentId = restore.runtime.agentId;
  let resolvedStateDirBeforeRestore;
  try {
    applyEvidenceEnv(localRootKey);
    resolvedStateDirBeforeRestore = resolveStateDir();
    await restoreLocalAgentBackup(restore.runtime, backup.fileName);
  } finally {
    await restore.cleanup();
  }

  const summary = {
    issue: 9963,
    scenarioId,
    phrase,
    stateDir,
    pgliteDir,
    sourceAgentId,
    restoreAgentId,
    backup,
    seeded,
    resolvedStateDirBeforeBackup,
    resolvedStateDirBeforeRestore,
    localRootKeySha256: sha256(localRootKey),
    restoredAt: new Date().toISOString(),
    nextCommand: `ELIZA_STATE_DIR=${stateDir} ELIZA_SCENARIO_PGLITE_DIR=${pgliteDir} ELIZA_SAVE_TRAJECTORIES=1 packages/scenario-runner/bin/eliza-scenarios run packages/test/scenarios/backup --scenario ${scenarioId}`,
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
process.exit(0);
