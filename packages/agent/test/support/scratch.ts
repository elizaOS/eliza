// spec/agent/host/launch.md, "Story: Start the agent from one launch document"; spec/agent/host/launch.md, "The launch frame is one stdin line with the token, the epoch, and the optional credential and storage key"
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Scratch {
  readonly path: string;
  /** @throws {never} */
  file(name: string): string;
  remove(): Promise<void>;
}

export async function scratchDirectory(prefix: string): Promise<Scratch> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)));
  return { path, file: (name) => join(path, name), remove: () => rm(path, { recursive: true, force: true }) };
}

export type Backend =
  | { readonly kind: "cloud"; readonly origin: string; readonly smallModel?: string; readonly largeModel?: string; readonly imageModel?: string }
  | { readonly kind: "ownKey"; readonly baseUrl: string; readonly smallModel: string; readonly largeModel: string }
  | { readonly kind: "none" };

export interface LaunchOptions {
  readonly backend?: Backend;
  readonly name?: string;
  readonly system?: string;
  readonly allowed?: readonly string[];
  readonly load?: readonly string[];
  readonly productPlugin?: string;
  readonly persistMemory?: boolean;
  readonly callerRole?: "Owner" | "User";
  readonly retention?: { readonly days: number; readonly maxRowsPerRoom: number; readonly intervalMinutes: number };
  readonly privacy?: { readonly secretSwap: boolean; readonly piiSwap: boolean };
  readonly google?: { readonly gmailChanges: boolean; readonly calendarEdits: boolean };
  readonly workflowWorker?: { readonly runtimeDir: string; readonly executable: string; readonly sha256: string };
  readonly hostContextRevision?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export const account = { userId: "owner-user", organizationId: "owner-org" } as const;

function model(backend: Backend): Record<string, string> {
  switch (backend.kind) {
    case "cloud":
      return { backend: "cloud", cloudBaseUrl: backend.origin, smallModel: backend.smallModel ?? "small", largeModel: backend.largeModel ?? "large", imageModel: backend.imageModel ?? "small" };
    case "ownKey":
      return { backend: "ownKey", ownKeyBaseUrl: backend.baseUrl, ownKeySmall: backend.smallModel, ownKeyLarge: backend.largeModel };
    case "none":
      return { backend: "none" };
    default: {
      const unhandled: never = backend;
      throw new TypeError(`unknown backend ${JSON.stringify(unhandled)}`);
    }
  }
}

export function launchDocument(options: LaunchOptions = {}): Record<string, unknown> {
  const backend = options.backend ?? { kind: "none" };
  return {
    schema: 1,
    character: { name: options.name ?? "Eliza", system: options.system ?? "You are a helpful assistant on the owner's device." },
    policy: {
      actions: { allowed: options.allowed ?? ["REPLY", "IGNORE", "NONE"] },
      plugins: { load: options.load ?? [] },
      ...(options.productPlugin === undefined ? {} : { productPlugin: options.productPlugin }),
    },
    model: model(backend),
    ...(backend.kind === "none" ? {} : { account }),
    embeddings: "none",
    persistMemory: options.persistMemory ?? false,
    callerRole: options.callerRole ?? "User",
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    ...(options.privacy === undefined ? {} : { privacy: options.privacy }),
    ...(options.google === undefined ? {} : { google: options.google }),
    ...(options.workflowWorker === undefined ? {} : { workflowWorker: options.workflowWorker }),
    ...(options.hostContextRevision === undefined ? {} : { hostContextRevision: options.hostContextRevision }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

export async function writeLaunch(scratch: Scratch, document: Record<string, unknown>, name = "launch.json"): Promise<string> {
  const file = scratch.file(name);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export interface FrameOptions {
  readonly epoch?: number;
  readonly credential?: { readonly version: number; readonly value: string };
  readonly storageKey?: string;
}

export interface LaunchFrame {
  readonly version: 1;
  readonly token: string;
  readonly epoch: number;
  readonly credential?: { readonly version: number; readonly value: string };
  readonly storageKey?: string;
}

/** @throws {never} */
export function launchFrame(options: FrameOptions = {}): LaunchFrame {
  return {
    version: 1,
    token: randomBytes(32).toString("base64url"),
    epoch: options.epoch ?? 1,
    ...(options.credential === undefined ? {} : { credential: options.credential }),
    ...(options.storageKey === undefined ? {} : { storageKey: options.storageKey }),
  };
}
