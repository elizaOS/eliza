/**
 * Durable, non-secret desired-state for Advanced SSH tunnels.
 *
 * Access tokens and the trusted host fingerprint remain in the platform secure
 * store. Private keys remain in place and only their path is retained here.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./native/auth-bridge";

const STORE_VERSION = 1 as const;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const SSH_TARGET_PATTERN = /^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

export interface SshRuntimeConnectionIntent {
  runtimeId: string;
  target: string;
  sshPort: number;
  remoteApiPort: number;
  expectedFingerprint: string;
  identityFile?: string;
  credentialRef: string;
}

interface StoredSshRuntimeIntents {
  version: typeof STORE_VERSION;
  intents: SshRuntimeConnectionIntent[];
}

export interface SshRuntimeIntentFileSystem {
  mkdir(
    path: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options: { force: true }): Promise<unknown>;
}

function validPort(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 65_535
  );
}

function parseIntent(value: unknown): SshRuntimeConnectionIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored SSH runtime connection intent is corrupt.");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "runtimeId",
    "target",
    "sshPort",
    "remoteApiPort",
    "expectedFingerprint",
    "identityFile",
    "credentialRef",
  ]);
  const identityFile = record.identityFile;
  const credentialRef = record.credentialRef;
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    typeof record.runtimeId !== "string" ||
    !RUNTIME_ID_PATTERN.test(record.runtimeId) ||
    typeof record.target !== "string" ||
    !SSH_TARGET_PATTERN.test(record.target) ||
    !validPort(record.sshPort) ||
    !validPort(record.remoteApiPort) ||
    typeof record.expectedFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(record.expectedFingerprint) ||
    (identityFile !== undefined &&
      (typeof identityFile !== "string" ||
        !path.isAbsolute(identityFile) ||
        identityFile.length > 4_096 ||
        /[\r\n\0]/.test(identityFile))) ||
    typeof credentialRef !== "string" ||
    credentialRef !== record.runtimeId
  ) {
    throw new Error("Stored SSH runtime connection intent is corrupt.");
  }
  return {
    runtimeId: record.runtimeId,
    target: record.target,
    sshPort: record.sshPort,
    remoteApiPort: record.remoteApiPort,
    expectedFingerprint: record.expectedFingerprint,
    ...(typeof identityFile === "string" ? { identityFile } : {}),
    credentialRef,
  };
}

function parseStore(raw: string): StoredSshRuntimeIntents {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 native durable state is untrusted input.
    throw new Error("Stored SSH runtime connection intents are corrupt.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored SSH runtime connection intents are corrupt.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== STORE_VERSION || !Array.isArray(record.intents)) {
    throw new Error("Stored SSH runtime connection intents are corrupt.");
  }
  const intents = record.intents.map(parseIntent);
  if (
    new Set(intents.map((intent) => intent.runtimeId)).size !== intents.length
  ) {
    throw new Error("Stored SSH runtime connection intents are corrupt.");
  }
  return { version: STORE_VERSION, intents };
}

export function resolveSshRuntimeIntentPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveStateDir(env),
    "ssh-runtime",
    "connection-intents-v1.json",
  );
}

export class SshRuntimeIntentStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storePath = resolveSshRuntimeIntentPath(),
    private readonly fileSystem: SshRuntimeIntentFileSystem = fs,
  ) {}

  async list(): Promise<SshRuntimeConnectionIntent[]> {
    try {
      return parseStore(await this.fileSystem.readFile(this.storePath, "utf8"))
        .intents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(runtimeId: string): Promise<SshRuntimeConnectionIntent | null> {
    return (
      (await this.list()).find((intent) => intent.runtimeId === runtimeId) ??
      null
    );
  }

  upsert(intentValue: SshRuntimeConnectionIntent): Promise<void> {
    const intent = parseIntent(intentValue);
    return this.mutate(async (intents) => {
      const next = intents.filter(
        (item) => item.runtimeId !== intent.runtimeId,
      );
      next.push(intent);
      next.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
      return next;
    });
  }

  delete(runtimeId: string): Promise<boolean> {
    if (!RUNTIME_ID_PATTERN.test(runtimeId)) {
      return Promise.reject(new Error("Runtime id is invalid."));
    }
    let deleted = false;
    return this.mutate(async (intents) => {
      const next = intents.filter((intent) => intent.runtimeId !== runtimeId);
      deleted = next.length !== intents.length;
      return next;
    }).then(() => deleted);
  }

  private async mutate(
    operation: (
      intents: SshRuntimeConnectionIntent[],
    ) => Promise<SshRuntimeConnectionIntent[]>,
  ): Promise<void> {
    const predecessor = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor.catch(() => undefined);
    try {
      await this.write(await operation(await this.list()));
    } finally {
      release();
    }
  }

  private async write(intents: SshRuntimeConnectionIntent[]): Promise<void> {
    const directory = path.dirname(this.storePath);
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.fileSystem.chmod(directory, 0o700);
    const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      await this.fileSystem.writeFile(
        temporaryPath,
        `${JSON.stringify({ version: STORE_VERSION, intents })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await this.fileSystem.rename(temporaryPath, this.storePath);
      await this.fileSystem.chmod(this.storePath, 0o600);
    } finally {
      await this.fileSystem.rm(temporaryPath, { force: true });
    }
  }
}

export const sshRuntimeIntentStoreInternals = {
  parseIntent,
  parseStore,
};
