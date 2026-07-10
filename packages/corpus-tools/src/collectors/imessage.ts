/**
 * Read-only iMessage history collector for the private personal corpus. It
 * snapshots chat.db through SQLite's online backup API, walks a fixed ROWID
 * window through the connector's strict reader, hashes local attachment bytes,
 * and atomically replaces deterministic monthly shards. Raw identifiers and
 * message content stay in ignored local storage; the shareable report contains
 * only structural counts and keyed chat identifiers.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { type Dirent, promises as fs, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import type {
  ChatDbAttachment,
  ChatDbChatSummary,
  ChatDbMessage,
  ChatDbReader,
  ChatDbSnapshot,
} from "@elizaos/plugin-imessage";
import { z } from "zod";
import {
  CORPUS_ANCHOR_MS,
  CORPUS_CUTOFF_MS,
  type CorpusAttachment,
  type CorpusManifest,
  type CorpusMessage,
  corpusMessageSchema,
} from "../schema.ts";
import { buildCorpusManifest } from "../validator.ts";

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const OWNER_SALT_FILE = "imessage-chat-id.key";
const TRANSACTION_FILE = ".corpus-transaction.json";
const runtimeRequire = createRequire(import.meta.url);

const corpusTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  accountId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  phase: z.enum([
    "prepared",
    "old-moved",
    "new-installed",
    "manifest-committed",
  ]),
  destination: z.string().min(1),
  backup: z.string().min(1),
  stage: z.string().min(1),
  manifestPath: z.string().min(1),
  reportPath: z.string().min(1),
  hadDestination: z.boolean(),
  priorManifestBase64: z.string().nullable(),
  priorReportBase64: z.string().nullable(),
});

type CorpusTransaction = z.infer<typeof corpusTransactionSchema>;

interface IMessageRuntimeModule {
  DEFAULT_CHAT_DB_PATH: string;
  openChatDb(path: string): Promise<ChatDbReader | null>;
  snapshotChatDb(
    sourcePath: string,
    destinationPath: string,
  ): Promise<ChatDbSnapshot>;
}

export interface IMessageCollectorRuntime {
  defaultDbPath: string;
  openReader(path: string): Promise<ChatDbReader | null>;
  snapshot(
    sourcePath: string,
    destinationPath: string,
  ): Promise<ChatDbSnapshot>;
}

export interface CollectIMessageOptions {
  outputRoot: string;
  stateDir: string;
  accountId: string;
  ownerId: string;
  ownerDisplay: string;
  ownerAddress?: string;
  dbPath?: string;
  attachmentRoot?: string;
  sinceMs?: number;
  untilMs?: number;
  pageSize?: number;
  runtime?: IMessageCollectorRuntime;
}

export interface IMessageCollectionReport {
  schemaVersion: 1;
  platform: "imessage";
  accountId: string;
  sourceSnapshot: { sha256: string; bytes: number; throughRowId: number };
  window: { sinceMs: number; untilMs: number };
  totals: {
    sourceRows: number;
    includedMessages: number;
    excludedReactions: number;
    excludedSystem: number;
    excludedOther: number;
    externalReplies: number;
    attachments: number;
    attachmentBytes: number;
  };
  byChat: Array<{
    chatIdHash: string;
    count: number;
    firstTs: number;
    lastTs: number;
    inCount: number;
    outCount: number;
    attachmentCount: number;
  }>;
  shardSha256: Array<{ path: string; sha256: string; count: number }>;
}

export interface IMessageCollectionResult {
  report: IMessageCollectionReport;
  manifest: CorpusManifest;
  reportPath: string;
  manifestPath: string;
}

async function loadRuntime(): Promise<IMessageCollectorRuntime> {
  const module = (await import(
    "@elizaos/plugin-imessage"
  )) as IMessageRuntimeModule;
  return {
    defaultDbPath: module.DEFAULT_CHAT_DB_PATH,
    openReader: module.openChatDb,
    snapshot: module.snapshotChatDb,
  };
}

function validateOptions(options: CollectIMessageOptions): {
  sinceMs: number;
  untilMs: number;
  pageSize: number;
} {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.accountId)) {
    throw new ElizaError("iMessage corpus accountId must be a path-safe slug", {
      code: "CORPUS_IMESSAGE_INVALID_ACCOUNT",
    });
  }
  if (!options.ownerId.trim() || !options.ownerDisplay.trim()) {
    throw new ElizaError("iMessage corpus owner identity is required", {
      code: "CORPUS_IMESSAGE_INVALID_OWNER",
    });
  }
  const sinceMs = options.sinceMs ?? CORPUS_CUTOFF_MS;
  const untilMs = options.untilMs ?? CORPUS_ANCHOR_MS;
  if (
    !Number.isSafeInteger(sinceMs) ||
    !Number.isSafeInteger(untilMs) ||
    sinceMs < CORPUS_CUTOFF_MS ||
    untilMs > CORPUS_ANCHOR_MS ||
    untilMs <= sinceMs
  ) {
    throw new ElizaError(
      "iMessage collection window must stay within the canonical corpus window",
      {
        code: "CORPUS_IMESSAGE_INVALID_WINDOW",
        context: { sinceMs, untilMs },
      },
    );
  }
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new ElizaError(
      "iMessage collection page size must be between 1 and 1000",
      {
        code: "CORPUS_IMESSAGE_INVALID_PAGE_SIZE",
        context: { pageSize },
      },
    );
  }
  return { sinceMs, untilMs, pageSize };
}

async function assertSeparatedPaths(
  outputRoot: string,
  stateDir: string,
  dbPath: string,
): Promise<void> {
  const output = path.resolve(outputRoot);
  const state = path.resolve(stateDir);
  const source = path.resolve(dbPath);
  const overlaps = (left: string, right: string) => {
    const relative = path.relative(left, right);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== "..")
    );
  };
  if (
    overlaps(output, state) ||
    overlaps(state, output) ||
    overlaps(output, source) ||
    overlaps(state, source)
  ) {
    throw new ElizaError(
      "iMessage source, output, and state paths must not overlap",
      {
        code: "CORPUS_IMESSAGE_PATH_OVERLAP",
      },
    );
  }
  for (const candidate of [output, state]) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new ElizaError(
          "iMessage output and state paths may not be symlinks",
          {
            code: "CORPUS_IMESSAGE_UNSAFE_PATH",
            context: { path: candidate },
          },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // error-policy:J3 A missing destination is valid input and will be created privately.
    }
  }
}

async function assertNoSymlinkComponents(targetPath: string): Promise<void> {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        const macSystemAlias =
          (current === "/var" || current === "/tmp") &&
          (await fs.realpath(current)).startsWith("/private/");
        if (macSystemAlias) continue;
        throw new ElizaError(
          "iMessage collector paths may not contain symlink components",
          {
            code: "CORPUS_IMESSAGE_UNSAFE_PATH",
            context: { path: current },
          },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // error-policy:J2 Path-component validation preserves the filesystem cause.
      throw error;
    }
  }
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

async function directoryIdentity(
  directory: string,
): Promise<DirectoryIdentity> {
  const stat = await fs.stat(directory, { bigint: true });
  if (!stat.isDirectory()) {
    throw new ElizaError("iMessage collector destination must be a directory", {
      code: "CORPUS_IMESSAGE_UNSAFE_PATH",
      context: { path: directory },
    });
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryUnchanged(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  await assertNoSymlinkComponents(directory);
  const current = await directoryIdentity(directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new ElizaError(
      "iMessage collector destination changed during collection",
      {
        code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED",
        context: { path: directory },
      },
    );
  }
}

function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith(`~${path.sep}`)
      ? path.join(homedir(), value.slice(2))
      : value;
}

interface OpenAtLibrary {
  symbols: {
    openat(directoryFd: number, pathPointer: object, flags: number): number;
    close(fd: number): number;
  };
  close(): void;
}

interface FlockLibrary {
  symbols: {
    flock(fd: number, operation: number): number;
  };
  close(): void;
}

interface BunFfiModule {
  FFIType: { i32: number; cstring: number };
  ptr(bytes: Uint8Array): object;
  dlopen(
    library: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ): OpenAtLibrary | FlockLibrary;
}

function nativeLibraryPath(): string {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new ElizaError(
    "Descriptor-relative filesystem operations are unsupported on this platform",
    {
      code: "CORPUS_IMESSAGE_OPENAT_UNAVAILABLE",
      context: { platform: process.platform },
    },
  );
}

async function openContainedFile(rootPath: string, requestedPath: string) {
  const lexicalRoot = path.resolve(rootPath);
  const lexicalTarget = path.resolve(requestedPath);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ElizaError(
      "iMessage attachment resolved outside the allowed attachment root",
      { code: "CORPUS_IMESSAGE_ATTACHMENT_PATH_ESCAPE" },
    );
  }
  const components = relative.split(path.sep).filter(Boolean);
  const filename = components.pop();
  if (!filename) {
    throw new ElizaError("iMessage attachment path has no file component", {
      code: "CORPUS_IMESSAGE_ATTACHMENT_INVALID",
    });
  }
  let ffi: BunFfiModule;
  try {
    ffi = runtimeRequire("bun:ffi") as BunFfiModule;
  } catch (error) {
    // error-policy:J2 Descriptor-relative traversal requires the Bun CLI runtime.
    throw new ElizaError("Bun FFI is required for safe attachment traversal", {
      code: "CORPUS_IMESSAGE_OPENAT_UNAVAILABLE",
      cause: error,
    });
  }
  const library = ffi.dlopen(nativeLibraryPath(), {
    openat: {
      args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
    close: { args: [ffi.FFIType.i32], returns: ffi.FFIType.i32 },
  }) as OpenAtLibrary;
  await assertNoSymlinkComponents(lexicalRoot);
  const expectedRoot = await directoryIdentity(lexicalRoot);
  const canonicalRoot = await fs.realpath(lexicalRoot);
  const filesystemRoot = path.parse(canonicalRoot).root;
  const anchorHandle = await fs.open(
    filesystemRoot,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  const openedDescriptors: number[] = [];
  const encoder = new TextEncoder();
  const openRelative = (
    directoryFd: number,
    component: string,
    flags: number,
  ): number => {
    const bytes = encoder.encode(`${component}\0`);
    const fd = library.symbols.openat(directoryFd, ffi.ptr(bytes), flags);
    if (fd < 0) {
      throw new ElizaError(
        "Unable to open an iMessage attachment path component safely",
        { code: "CORPUS_IMESSAGE_ATTACHMENT_OPEN_FAILED" },
      );
    }
    openedDescriptors.push(fd);
    return fd;
  };
  try {
    let directoryFd = anchorHandle.fd;
    const rootComponents = path
      .relative(filesystemRoot, canonicalRoot)
      .split(path.sep)
      .filter(Boolean);
    for (const component of rootComponents) {
      directoryFd = openRelative(
        directoryFd,
        component,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
    }
    const rootDescriptorPath =
      process.platform === "darwin"
        ? `/dev/fd/${directoryFd}`
        : `/proc/self/fd/${directoryFd}`;
    const verifiedRoot = await fs.open(
      rootDescriptorPath,
      fsConstants.O_RDONLY,
    );
    try {
      const actualRoot = await verifiedRoot.stat({ bigint: true });
      if (
        actualRoot.dev !== expectedRoot.dev ||
        actualRoot.ino !== expectedRoot.ino
      ) {
        throw new ElizaError(
          "iMessage attachment root changed during descriptor acquisition",
          { code: "CORPUS_IMESSAGE_DIRECTORY_CHANGED" },
        );
      }
    } finally {
      await verifiedRoot.close();
    }
    for (const component of components) {
      directoryFd = openRelative(
        directoryFd,
        component,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
    }
    const fileFd = openRelative(
      directoryFd,
      filename,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const descriptorPath =
      process.platform === "darwin"
        ? `/dev/fd/${fileFd}`
        : `/proc/self/fd/${fileFd}`;
    return await fs.open(descriptorPath, fsConstants.O_RDONLY);
  } finally {
    for (const descriptor of openedDescriptors.reverse()) {
      if (library.symbols.close(descriptor) !== 0) {
        logger.warn(
          "[CorpusTools] Failed to close a descriptor-relative attachment handle",
        );
      }
    }
    await anchorHandle.close();
    library.close();
  }
}

async function hashAttachment(
  attachment: ChatDbAttachment,
  attachmentRoot: string,
): Promise<CorpusAttachment> {
  if (!attachment.path) {
    throw new ElizaError("iMessage attachment has no local byte path", {
      code: "CORPUS_IMESSAGE_ATTACHMENT_MISSING",
      context: { attachmentGuid: attachment.guid },
    });
  }
  const requestedPath = expandHome(attachment.path);
  const handle = await openContainedFile(attachmentRoot, requestedPath);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ElizaError("iMessage attachment is not a regular file", {
        code: "CORPUS_IMESSAGE_ATTACHMENT_INVALID",
        context: { attachmentGuid: attachment.guid },
      });
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new ElizaError("iMessage attachment changed while it was hashed", {
        code: "CORPUS_IMESSAGE_ATTACHMENT_CHANGED",
        context: { attachmentGuid: attachment.guid },
      });
    }
    const bytes = Number(after.size);
    if (
      !Number.isSafeInteger(bytes) ||
      (attachment.totalBytes !== null && attachment.totalBytes !== bytes)
    ) {
      throw new ElizaError("iMessage attachment size does not match chat.db", {
        code: "CORPUS_IMESSAGE_ATTACHMENT_SIZE_MISMATCH",
        context: {
          attachmentGuid: attachment.guid,
          databaseBytes: attachment.totalBytes,
          actualBytes: bytes,
        },
      });
    }
    return {
      filename: path.basename(attachment.transferName ?? attachment.path),
      mimeType: attachment.mimeType ?? "application/octet-stream",
      sha256: hash.digest("hex"),
      bytes,
    };
  } finally {
    await handle.close();
  }
}

function recipientsFor(
  row: ChatDbMessage,
  chats: ReadonlyMap<string, ChatDbChatSummary>,
  owner: { id: string; display: string; address?: string },
) {
  const chat = chats.get(row.chatId);
  if (!chat) {
    throw new ElizaError("iMessage row has no matching chat metadata", {
      code: "CORPUS_IMESSAGE_MISSING_CHAT",
      context: { rowId: row.rowId },
    });
  }
  const participants = [
    ...new Set(chat.participants.filter((participant) => participant.trim())),
  ]
    .sort()
    .filter((participant) => participant !== owner.id);
  if (!row.isFromMe) {
    const recipients = [
      {
        id: owner.id,
        display: owner.display,
        ...(owner.address ? { address: owner.address } : {}),
      },
    ];
    for (const participant of participants) {
      if (participant !== row.handle) {
        recipients.push({
          id: participant,
          display: participant,
          address: participant,
        });
      }
    }
    return recipients;
  }
  return participants.map((participant) => ({
    id: participant,
    display: participant,
    address: participant,
  }));
}

async function mapMessages(
  rows: ChatDbMessage[],
  chats: ReadonlyMap<string, ChatDbChatSummary>,
  options: CollectIMessageOptions,
  attachmentRoot: string,
): Promise<{
  messages: CorpusMessage[];
  excluded: Omit<
    IMessageCollectionReport["totals"],
    "sourceRows" | "includedMessages"
  >;
}> {
  const excluded = {
    excludedReactions: 0,
    excludedSystem: 0,
    excludedOther: 0,
    externalReplies: 0,
    attachments: 0,
    attachmentBytes: 0,
  };
  const includedRows: ChatDbMessage[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.kind === "reaction") {
      excluded.excludedReactions++;
      continue;
    }
    if (row.kind === "system") {
      excluded.excludedSystem++;
      continue;
    }
    if (row.kind !== "text") {
      excluded.excludedOther++;
      continue;
    }
    if (!row.guid || ids.has(row.guid)) {
      throw new ElizaError(
        "iMessage history contains a missing or duplicate message GUID",
        {
          code: "CORPUS_IMESSAGE_DUPLICATE_ID",
          context: { rowId: row.rowId },
        },
      );
    }
    if (!row.text.trim() && row.attachments.length === 0) {
      throw new ElizaError(
        "iMessage text row is undecodable and has no attachment payload",
        {
          code: "CORPUS_IMESSAGE_UNDECODABLE_MESSAGE",
          context: { rowId: row.rowId },
        },
      );
    }
    ids.add(row.guid);
    includedRows.push(row);
  }

  const owner = {
    id: options.ownerId.trim(),
    display: options.ownerDisplay.trim(),
    address: options.ownerAddress?.trim(),
  };
  const messages: CorpusMessage[] = [];
  for (const row of includedRows) {
    const attachments = await Promise.all(
      row.attachments.map((attachment) =>
        hashAttachment(attachment, attachmentRoot),
      ),
    );
    excluded.attachments += attachments.length;
    excluded.attachmentBytes += attachments.reduce(
      (sum, attachment) => sum + (attachment.bytes ?? 0),
      0,
    );
    const replyToId =
      row.replyToGuid && ids.has(row.replyToGuid) ? row.replyToGuid : undefined;
    if (row.replyToGuid && !replyToId) excluded.externalReplies++;
    const senderId = row.isFromMe ? owner.id : row.handle.trim();
    if (!senderId || !row.chatId.trim()) {
      throw new ElizaError(
        "iMessage row is missing a required sender or chat identity",
        {
          code: "CORPUS_IMESSAGE_MISSING_IDENTITY",
          context: { rowId: row.rowId },
        },
      );
    }
    const recipients = recipientsFor(row, chats, owner);
    if (recipients.length === 0) {
      throw new ElizaError("iMessage row has no resolvable recipients", {
        code: "CORPUS_IMESSAGE_MISSING_RECIPIENTS",
        context: { rowId: row.rowId },
      });
    }
    messages.push(
      corpusMessageSchema.parse({
        id: row.guid,
        platform: "imessage",
        accountId: options.accountId,
        threadId: row.chatId,
        ts: row.timestamp,
        direction: row.isFromMe ? "out" : "in",
        senderId,
        senderDisplay: row.isFromMe ? owner.display : senderId,
        recipients,
        ...(row.displayName?.trim() ? { subject: row.displayName.trim() } : {}),
        text: row.text.trim(),
        labels: row.service ? [`service:${row.service.toLowerCase()}`] : [],
        attachments,
        ...(replyToId ? { replyToId } : {}),
        scrubState: "raw",
      }),
    );
  }
  messages.sort(
    (left, right) => left.ts - right.ts || left.id.localeCompare(right.id),
  );
  return { messages, excluded };
}

async function privateKey(stateDir: string): Promise<Buffer> {
  const keyPath = path.join(stateDir, OWNER_SALT_FILE);
  try {
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error("invalid key length");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // error-policy:J2 A corrupt local pseudonymization key must never be silently rotated.
      throw new ElizaError(
        "Unable to read the iMessage report pseudonymization key",
        {
          code: "CORPUS_IMESSAGE_REPORT_KEY_INVALID",
          cause: error,
        },
      );
    }
    // error-policy:J3 First-run absence creates a new private key; malformed existing keys fail above.
    const key = randomBytes(32);
    await fs.writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
    return key;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await fs.open(directoryPath, fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function acquireCorpusLock(lockPath: string) {
  const handle = await fs.open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let ffi: BunFfiModule;
  try {
    ffi = runtimeRequire("bun:ffi") as BunFfiModule;
  } catch (error) {
    await handle.close();
    // error-policy:J2 Process-lifetime advisory locking requires the Bun CLI runtime.
    throw new ElizaError("Bun FFI is required for corpus locking", {
      code: "CORPUS_IMESSAGE_LOCK_UNAVAILABLE",
      cause: error,
    });
  }
  const library = ffi.dlopen(nativeLibraryPath(), {
    flock: {
      args: [ffi.FFIType.i32, ffi.FFIType.i32],
      returns: ffi.FFIType.i32,
    },
  }) as FlockLibrary;
  const locked = library.symbols.flock(handle.fd, 2 | 4) === 0;
  library.close();
  if (!locked) {
    await handle.close();
    throw new ElizaError(
      "Another iMessage corpus collection is already running",
      { code: "CORPUS_IMESSAGE_COLLECTION_LOCKED" },
    );
  }
  try {
    await handle.truncate(0);
    await handle.writeFile(`${process.pid}\n`);
    await handle.sync();
    await fs.chmod(lockPath, 0o600);
    await syncDirectory(path.dirname(lockPath));
    return handle;
  } catch (error) {
    await handle.close();
    // error-policy:J2 Lock initialization preserves its filesystem cause after releasing ownership.
    throw new ElizaError("Unable to initialize the corpus collection lock", {
      code: "CORPUS_IMESSAGE_LOCK_FAILED",
      cause: error,
    });
  }
}

async function writeAtomic(filePath: string, bytes: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (handle) {
      try {
        // error-policy:J6 The write failure remains primary after closing its private handle.
        await handle.close();
      } catch {
        // error-policy:J6 Preserve the actionable artifact publication error.
        logger.warn(
          "[CorpusTools] Failed to close a temporary artifact handle",
        );
      }
    }
    try {
      // error-policy:J6 A failed atomic publication may leave only its private temporary file.
      await fs.rm(temporary, { force: true });
    } catch {
      // error-policy:J6 Preserve the actionable publication error.
      logger.warn(
        "[CorpusTools] Failed to remove a private temporary artifact after write failure",
      );
    }
    // error-policy:J2 Artifact publication preserves its filesystem cause.
    throw new ElizaError("Unable to publish an iMessage corpus artifact", {
      code: "CORPUS_IMESSAGE_WRITE_FAILED",
      cause: error,
      context: { filePath },
    });
  }
}

async function readOptionalArtifact(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ElizaError(
        "Corpus artifacts must be regular non-symlink files",
        {
          code: "CORPUS_IMESSAGE_UNSAFE_PATH",
          context: { filePath },
        },
      );
    }
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // error-policy:J2 Artifact snapshot reads preserve their filesystem cause.
    throw error;
  }
}

async function restoreArtifact(
  filePath: string,
  prior: Buffer | null,
): Promise<void> {
  if (prior === null) {
    await removeDurable(filePath);
    return;
  }
  await writeAtomic(filePath, prior.toString("utf8"));
}

async function removeDurable(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

function assertTransactionPaths(
  outputRoot: string,
  transaction: CorpusTransaction,
): void {
  const expectedDestination = path.join(
    outputRoot,
    "imessage",
    transaction.accountId,
  );
  const platformDir = path.join(outputRoot, "imessage");
  const backupPrefix = `.${path.basename(outputRoot)}.imessage.${transaction.accountId}.`;
  if (
    transaction.destination !== expectedDestination ||
    transaction.manifestPath !== path.join(outputRoot, "manifest.json") ||
    transaction.reportPath !==
      path.join(
        outputRoot,
        ".reports",
        `imessage-${transaction.accountId}.json`,
      ) ||
    path.dirname(transaction.stage) !== platformDir ||
    !path
      .basename(transaction.stage)
      .startsWith(`.${transaction.accountId}.`) ||
    !path.basename(transaction.stage).endsWith(".stage") ||
    path.dirname(transaction.backup) !== path.dirname(outputRoot) ||
    !path.basename(transaction.backup).startsWith(backupPrefix) ||
    !path.basename(transaction.backup).endsWith(".backup")
  ) {
    throw new ElizaError("Corpus transaction journal contains unsafe paths", {
      code: "CORPUS_IMESSAGE_TRANSACTION_INVALID",
    });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // error-policy:J2 Transaction recovery preserves unexpected filesystem failures.
    throw error;
  }
}

async function restorePreviousGeneration(
  transaction: CorpusTransaction,
): Promise<void> {
  await fs.rm(transaction.destination, { recursive: true, force: true });
  await syncDirectory(path.dirname(transaction.destination));
  if (transaction.hadDestination) {
    if (!(await pathExists(transaction.backup))) {
      throw new ElizaError(
        "Corpus transaction backup is missing during recovery",
        {
          code: "CORPUS_IMESSAGE_TRANSACTION_BACKUP_MISSING",
        },
      );
    }
    await fs.rename(transaction.backup, transaction.destination);
    await syncDirectory(path.dirname(transaction.destination));
    await syncDirectory(path.dirname(transaction.backup));
  }
  await restoreArtifact(
    transaction.manifestPath,
    transaction.priorManifestBase64 === null
      ? null
      : Buffer.from(transaction.priorManifestBase64, "base64"),
  );
  await restoreArtifact(
    transaction.reportPath,
    transaction.priorReportBase64 === null
      ? null
      : Buffer.from(transaction.priorReportBase64, "base64"),
  );
}

async function recoverCorpusTransaction(outputRoot: string): Promise<void> {
  const journalPath = path.join(outputRoot, TRANSACTION_FILE);
  const raw = await readOptionalArtifact(journalPath);
  if (raw === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    // error-policy:J3 A malformed private journal is explicit invalid state, never ignored.
    throw new ElizaError("Corpus transaction journal is malformed", {
      code: "CORPUS_IMESSAGE_TRANSACTION_INVALID",
      cause: error,
    });
  }
  const transaction = corpusTransactionSchema.parse(parsed);
  assertTransactionPaths(outputRoot, transaction);

  if (transaction.phase === "manifest-committed") {
    await fs.rm(transaction.backup, { recursive: true, force: true });
    await syncDirectory(path.dirname(transaction.backup));
  } else if (transaction.phase === "prepared") {
    const backupExists = await pathExists(transaction.backup);
    const destinationExists = await pathExists(transaction.destination);
    if (backupExists) {
      if (destinationExists) {
        throw new ElizaError(
          "Corpus transaction has both destination and backup before install",
          {
            code: "CORPUS_IMESSAGE_TRANSACTION_INVALID",
          },
        );
      }
      await fs.rename(transaction.backup, transaction.destination);
      await syncDirectory(path.dirname(transaction.destination));
      await syncDirectory(path.dirname(transaction.backup));
    }
    await restoreArtifact(
      transaction.manifestPath,
      transaction.priorManifestBase64 === null
        ? null
        : Buffer.from(transaction.priorManifestBase64, "base64"),
    );
    await restoreArtifact(
      transaction.reportPath,
      transaction.priorReportBase64 === null
        ? null
        : Buffer.from(transaction.priorReportBase64, "base64"),
    );
  } else {
    await restorePreviousGeneration(transaction);
  }
  await fs.rm(transaction.stage, { recursive: true, force: true });
  await syncDirectory(path.dirname(transaction.stage));
  await removeDurable(journalPath);
}

async function cleanupOrphanStages(outputRoot: string): Promise<void> {
  const platformDir = path.join(outputRoot, "imessage");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(platformDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // error-policy:J2 Orphan-stage inspection preserves unexpected filesystem failures.
    throw error;
  }
  let removed = false;
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      entry.name.startsWith(".") &&
      entry.name.endsWith(".stage")
    ) {
      await fs.rm(path.join(platformDir, entry.name), {
        recursive: true,
        force: true,
      });
      removed = true;
    }
  }
  if (removed) await syncDirectory(platformDir);
}

async function cleanupOrphanSnapshots(stateDir: string): Promise<void> {
  const entries = await fs.readdir(stateDir, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("imessage-snapshot-")) {
      await fs.rm(path.join(stateDir, entry.name), {
        recursive: true,
        force: true,
      });
      removed = true;
    }
  }
  if (removed) await syncDirectory(stateDir);
}

async function publishShards<T>(
  messages: CorpusMessage[],
  outputRoot: string,
  accountId: string,
  priorManifest: Buffer | null,
  reportPath: string,
  priorReport: Buffer | null,
  verifyAndPublishManifest: () => Promise<T>,
): Promise<T> {
  const platformDir = path.join(outputRoot, "imessage");
  const destination = path.join(platformDir, accountId);
  try {
    const platformStat = await fs.lstat(platformDir);
    if (platformStat.isSymbolicLink()) {
      throw new ElizaError(
        "iMessage corpus platform directory may not be a symlink",
        {
          code: "CORPUS_IMESSAGE_UNSAFE_PATH",
        },
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // error-policy:J3 First publication creates the platform directory.
  }
  const stage = path.join(platformDir, `.${accountId}.${randomUUID()}.stage`);
  const backup = path.join(
    path.dirname(outputRoot),
    `.${path.basename(outputRoot)}.imessage.${accountId}.${randomUUID()}.backup`,
  );
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  const byMonth = new Map<string, CorpusMessage[]>();
  for (const message of messages) {
    const month = new Date(message.ts).toISOString().slice(0, 7);
    const current = byMonth.get(month) ?? [];
    current.push(message);
    byMonth.set(month, current);
  }
  for (const [month, rows] of [...byMonth.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    await writeAtomic(
      path.join(stage, `${month}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  }
  const journalPath = path.join(outputRoot, TRANSACTION_FILE);
  const transaction: CorpusTransaction = {
    schemaVersion: 1,
    accountId,
    phase: "prepared",
    destination,
    backup,
    stage,
    manifestPath: path.join(outputRoot, "manifest.json"),
    reportPath,
    hadDestination: await pathExists(destination),
    priorManifestBase64: priorManifest?.toString("base64") ?? null,
    priorReportBase64: priorReport?.toString("base64") ?? null,
  };
  let committed = false;
  let result: T | undefined;
  try {
    await writeAtomic(journalPath, `${JSON.stringify(transaction, null, 2)}\n`);
    if (transaction.hadDestination) {
      await fs.rename(destination, backup);
      await syncDirectory(platformDir);
      await syncDirectory(path.dirname(backup));
    }
    transaction.phase = "old-moved";
    await writeAtomic(journalPath, `${JSON.stringify(transaction, null, 2)}\n`);
    await fs.rename(stage, destination);
    await syncDirectory(platformDir);
    transaction.phase = "new-installed";
    await writeAtomic(journalPath, `${JSON.stringify(transaction, null, 2)}\n`);
    result = await verifyAndPublishManifest();
    transaction.phase = "manifest-committed";
    await writeAtomic(journalPath, `${JSON.stringify(transaction, null, 2)}\n`);
    committed = true;
  } catch (error) {
    try {
      // error-policy:J6 Durable journal recovery restores the prior generation before returning failure.
      if (await pathExists(journalPath)) {
        await recoverCorpusTransaction(outputRoot);
      } else {
        await fs.rm(stage, { recursive: true, force: true });
        await syncDirectory(platformDir);
      }
    } catch (rollbackError) {
      // error-policy:J2 Recovery failure preserves the original publication failure in context.
      throw new ElizaError(
        "Unable to recover the corpus publication transaction",
        {
          code: "CORPUS_IMESSAGE_TRANSACTION_RECOVERY_FAILED",
          cause: rollbackError,
          context: {
            publicationError:
              error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    // error-policy:J2 Account publication preserves its atomic-swap cause.
    throw new ElizaError(
      "Unable to atomically publish iMessage corpus shards",
      {
        code: "CORPUS_IMESSAGE_PUBLISH_FAILED",
        cause: error,
      },
    );
  } finally {
    if (transaction.hadDestination && committed) {
      try {
        // error-policy:J6 The new shard directory is already published and fully validated in memory.
        await fs.rm(backup, { recursive: true, force: true });
        await syncDirectory(path.dirname(backup));
      } catch {
        // error-policy:J6 A private backup is safer than risking deletion of the published directory.
        logger.warn(
          "[CorpusTools] Failed to remove the previous private iMessage shard directory",
        );
      }
    }
    if (committed) {
      try {
        // error-policy:J6 A committed journal is retained only if durable cleanup fails.
        await fs.rm(stage, { recursive: true, force: true });
        await syncDirectory(platformDir);
        await removeDurable(journalPath);
      } catch {
        // error-policy:J6 The next locked collector run finalizes a committed journal.
        logger.warn(
          "[CorpusTools] Deferred cleanup of a committed corpus transaction",
        );
      }
    }
  }
  if (!committed || result === undefined) {
    throw new ElizaError(
      "iMessage shard publication completed without a manifest result",
      {
        code: "CORPUS_IMESSAGE_PUBLISH_INCOMPLETE",
      },
    );
  }
  return result;
}

function buildCollectionReport(
  options: CollectIMessageOptions,
  messages: CorpusMessage[],
  excluded: Omit<
    IMessageCollectionReport["totals"],
    "sourceRows" | "includedMessages"
  >,
  sourceRows: number,
  snapshot: ChatDbSnapshot,
  throughRowId: number,
  sinceMs: number,
  untilMs: number,
  reportKey: Buffer,
  manifest: CorpusManifest,
): IMessageCollectionReport {
  const chatStats = new Map<
    string,
    IMessageCollectionReport["byChat"][number]
  >();
  for (const message of messages) {
    const chatIdHash = createHmac("sha256", reportKey)
      .update(message.threadId)
      .digest("hex");
    const current = chatStats.get(chatIdHash) ?? {
      chatIdHash,
      count: 0,
      firstTs: message.ts,
      lastTs: message.ts,
      inCount: 0,
      outCount: 0,
      attachmentCount: 0,
    };
    current.count++;
    current.firstTs = Math.min(current.firstTs, message.ts);
    current.lastTs = Math.max(current.lastTs, message.ts);
    current[message.direction === "in" ? "inCount" : "outCount"]++;
    current.attachmentCount += message.attachments.length;
    chatStats.set(chatIdHash, current);
  }
  const shardEntries = manifest.shards.filter(
    (entry) =>
      entry.platform === "imessage" && entry.accountId === options.accountId,
  );
  return {
    schemaVersion: 1,
    platform: "imessage",
    accountId: options.accountId,
    sourceSnapshot: {
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      throughRowId,
    },
    window: { sinceMs, untilMs },
    totals: {
      sourceRows,
      includedMessages: messages.length,
      ...excluded,
    },
    byChat: [...chatStats.values()].sort((left, right) =>
      left.chatIdHash.localeCompare(right.chatIdHash),
    ),
    shardSha256: shardEntries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      count: entry.count,
    })),
  };
}

export async function collectIMessageCorpus(
  options: CollectIMessageOptions,
): Promise<IMessageCollectionResult> {
  const { sinceMs, untilMs, pageSize } = validateOptions(options);
  const runtime = options.runtime ?? (await loadRuntime());
  const dbPath = path.resolve(options.dbPath ?? runtime.defaultDbPath);
  const requestedOutputRoot = path.resolve(options.outputRoot);
  const requestedStateDir = path.resolve(options.stateDir);
  await assertSeparatedPaths(requestedOutputRoot, requestedStateDir, dbPath);
  await assertNoSymlinkComponents(requestedOutputRoot);
  await assertNoSymlinkComponents(requestedStateDir);
  await fs.mkdir(requestedOutputRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(requestedStateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(requestedOutputRoot, 0o700);
  await fs.chmod(requestedStateDir, 0o700);
  const outputRoot = await fs.realpath(requestedOutputRoot);
  const stateDir = await fs.realpath(requestedStateDir);
  const canonicalDbPath = await fs.realpath(dbPath);
  await assertSeparatedPaths(outputRoot, stateDir, canonicalDbPath);
  const outputIdentity = await directoryIdentity(outputRoot);
  const stateIdentity = await directoryIdentity(stateDir);
  const lockPath = path.join(outputRoot, ".corpus-collection.lock");
  const lockHandle = await acquireCorpusLock(lockPath);
  let stateLockHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    stateLockHandle = await acquireCorpusLock(
      path.join(stateDir, ".imessage-snapshot.lock"),
    );
    await cleanupOrphanSnapshots(stateDir);
    await recoverCorpusTransaction(outputRoot);
    await cleanupOrphanStages(outputRoot);
    try {
      const existing = await buildCorpusManifest(outputRoot);
      if (existing.issues.length > 0) {
        throw new ElizaError(
          "Existing corpus output is invalid; refusing to replace one account",
          {
            code: "CORPUS_IMESSAGE_EXISTING_OUTPUT_INVALID",
            context: { issueCount: existing.issues.length },
          },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // error-policy:J3 First publication has no existing corpus root to validate.
    }
    const snapshotDir = path.join(
      stateDir,
      `imessage-snapshot-${randomUUID()}`,
    );
    await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });
    const snapshotPath = path.join(snapshotDir, "chat.db");
    try {
      const snapshot = await runtime.snapshot(canonicalDbPath, snapshotPath);
      const reader = await runtime.openReader(snapshotPath);
      if (!reader) {
        throw new ElizaError(
          "The consistent iMessage snapshot could not be opened",
          {
            code: "CORPUS_IMESSAGE_SNAPSHOT_OPEN_FAILED",
          },
        );
      }

      let rows: ChatDbMessage[] = [];
      let chats: ChatDbChatSummary[] = [];
      let throughRowId = 0;
      try {
        throughRowId = reader.getLatestRowIdStrict();
        chats = reader.listChatsStrict();
        let cursor = 0;
        while (cursor < throughRowId) {
          const page = reader.pageMessages({
            sinceMs,
            untilMs,
            afterRowId: cursor,
            throughRowId,
            limit: pageSize,
          });
          if (page.length === 0) break;
          const next = page.at(-1)?.rowId;
          if (!next || next <= cursor) {
            throw new ElizaError(
              "iMessage reader failed to advance its ROWID cursor",
              {
                code: "CORPUS_IMESSAGE_CURSOR_STALLED",
                context: { cursor, throughRowId },
              },
            );
          }
          rows = rows.concat(page);
          cursor = next;
        }
      } finally {
        reader.close();
      }

      const chatMap = new Map(chats.map((chat) => [chat.chatId, chat]));
      const attachmentRoot = path.resolve(
        expandHome(options.attachmentRoot ?? "~/Library/Messages/Attachments"),
      );
      const mapped = await mapMessages(rows, chatMap, options, attachmentRoot);
      const manifestPath = path.join(outputRoot, "manifest.json");
      const reportPath = path.join(
        outputRoot,
        ".reports",
        `imessage-${options.accountId}.json`,
      );
      const reportKey = await privateKey(stateDir);
      const priorManifest = await readOptionalArtifact(manifestPath);
      const priorReport = await readOptionalArtifact(reportPath);
      const transaction = await publishShards(
        mapped.messages,
        outputRoot,
        options.accountId,
        priorManifest,
        reportPath,
        priorReport,
        async () => {
          const candidate = await buildCorpusManifest(outputRoot);
          if (candidate.issues.length > 0) {
            throw new ElizaError(
              "Published iMessage shards failed corpus validation",
              {
                code: "CORPUS_IMESSAGE_VALIDATION_FAILED",
                context: { issueCount: candidate.issues.length },
              },
            );
          }
          const report = buildCollectionReport(
            options,
            mapped.messages,
            mapped.excluded,
            rows.length,
            snapshot,
            throughRowId,
            sinceMs,
            untilMs,
            reportKey,
            candidate.manifest,
          );
          await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
          await writeAtomic(
            manifestPath,
            `${JSON.stringify(candidate.manifest, null, 2)}\n`,
          );
          await assertDirectoryUnchanged(outputRoot, outputIdentity);
          await assertDirectoryUnchanged(stateDir, stateIdentity);
          return { manifestResult: candidate, report };
        },
      );
      return {
        report: transaction.report,
        manifest: transaction.manifestResult.manifest,
        reportPath,
        manifestPath,
      };
    } finally {
      try {
        // error-policy:J6 The snapshot is private ephemeral input after success or failure.
        await fs.rm(snapshotDir, { recursive: true, force: true });
      } catch {
        // error-policy:J6 Collection success/failure is already observable; teardown must not replace it.
        logger.warn(
          "[CorpusTools] Failed to remove the private iMessage database snapshot",
        );
      }
    }
  } finally {
    if (stateLockHandle) {
      try {
        // error-policy:J6 Closing the descriptor releases the state-directory snapshot lock.
        await stateLockHandle.close();
      } catch {
        // error-policy:J6 Process exit also releases the snapshot lock if descriptor close fails.
        logger.warn(
          "[CorpusTools] Failed to close the iMessage snapshot lock handle",
        );
      }
    }
    try {
      // error-policy:J6 Closing the descriptor releases the kernel-owned advisory lock.
      await lockHandle.close();
    } catch {
      // error-policy:J6 Process exit also releases the advisory lock if descriptor close fails.
      logger.warn(
        "[CorpusTools] Failed to close the iMessage collection lock handle",
      );
    }
  }
}
