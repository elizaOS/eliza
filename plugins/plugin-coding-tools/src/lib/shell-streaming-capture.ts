/**
 * Captures foreground shell streams without source-sized runtime buffers.
 *
 * Raw bytes are written only as authenticated AES-GCM ciphertext. Finalization
 * decrypts each complete stream in memory solely to apply the runtime's exact
 * redaction contract, then atomically publishes immutable redacted segments.
 * Crash residue has no persisted key and is swept before later captures.
 */
import {
  type CipherGCM,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type IAgentRuntime,
  resolveStateDir,
  toWellFormedUnicode,
} from "@elizaos/core";
import { redactShellText } from "../shell/redaction.js";
import {
  persistShellOutputArtifact,
  type ShellOutputArtifact,
  type ShellStreamMetrics,
} from "./shell-output-artifact.js";

const CAPTURE_ROOT_SEGMENTS = [
  "coding-tools",
  "shell-output-captures",
] as const;
const CAPTURE_STALE_MS = 60 * 60 * 1000;
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;
const MODEL_PROJECTION_LIMIT_CHARS = 20_000;

type CaptureStreamName = "stdout" | "stderr";

interface StreamState {
  cipher: CipherGCM;
  output: WriteStream;
  filePath: string;
  key: Buffer;
  metrics: ShellStreamMetrics;
  endedWithNewline: boolean;
  failed: Error | null;
}

export interface ShellCaptureProjection {
  stdout: string;
  stderr: string;
  stdoutComplete: boolean;
  stderrComplete: boolean;
  modelCharacters: number;
}

export interface FinalizedShellCapture {
  artifact: ShellOutputArtifact;
  projection: ShellCaptureProjection;
}

export interface ShellCaptureOutcome {
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  ownerAgentId: string;
  ownerConversationId: string;
}

function updateMetrics(
  metrics: ShellStreamMetrics,
  chunk: string,
  priorEndedWithNewline: boolean,
): boolean {
  metrics.characters += chunk.length;
  metrics.bytes += Buffer.byteLength(chunk, "utf8");
  const newlines = chunk.match(/\n/g)?.length ?? 0;
  if (metrics.characters === chunk.length) {
    metrics.lines =
      chunk.length === 0 ? 0 : newlines + (chunk.endsWith("\n") ? 0 : 1);
  } else {
    metrics.lines += newlines;
    if (priorEndedWithNewline && chunk.length > 0 && !chunk.endsWith("\n")) {
      metrics.lines += 1;
    }
  }
  return chunk.endsWith("\n");
}

async function ensureCaptureRoot(): Promise<string> {
  const root = path.join(resolveStateDir(), ...CAPTURE_ROOT_SEGMENTS);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("shell capture root is not a private directory");
  }
  await fs.chmod(root, 0o700);
  const now = Date.now();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".capture-")) continue;
    const entryPath = path.join(root, entry.name);
    try {
      const entryStat = await fs.lstat(entryPath);
      if (
        !entryStat.isSymbolicLink() &&
        now - entryStat.mtimeMs > CAPTURE_STALE_MS
      ) {
        await fs.rm(entryPath, { recursive: true });
      }
    } catch {
      // error-policy:J6 stale encrypted capture cleanup is best effort.
    }
  }
  return root;
}

async function createStreamState(
  directory: string,
  name: CaptureStreamName,
): Promise<StreamState> {
  const key = randomBytes(AES_KEY_BYTES);
  const iv = randomBytes(AES_IV_BYTES);
  const filePath = path.join(directory, `${name}.enc`);
  const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  output.write(iv);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.pipe(output, { end: false });
  const state: StreamState = {
    cipher,
    output,
    filePath,
    key,
    metrics: { characters: 0, bytes: 0, lines: 0 },
    endedWithNewline: false,
    failed: null,
  };
  const fail = (error: Error) => {
    state.failed ??= error;
  };
  cipher.on("error", fail);
  output.on("error", fail);
  return state;
}

function awaitEvent(
  emitter: NodeJS.EventEmitter,
  success: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(success, resolve);
    emitter.once("error", reject);
  });
}

function projectStream(
  text: string,
  budget: number,
): { text: string; complete: boolean } {
  if (text.length <= budget) return { text, complete: true };
  const marker =
    "\n[model projection omitted content; read the artifact for exact continuation]\n";
  const contentBudget = Math.max(2, budget - marker.length);
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  let head = text.slice(0, headBudget);
  let tail = text.slice(text.length - tailBudget);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return {
    text: `${head}${marker}${tail}`,
    complete: false,
  };
}

function projectionFor(stdout: string, stderr: string): ShellCaptureProjection {
  const active = Number(stdout.length > 0) + Number(stderr.length > 0);
  const perStream =
    active > 1
      ? Math.floor(MODEL_PROJECTION_LIMIT_CHARS / 2)
      : MODEL_PROJECTION_LIMIT_CHARS;
  const projectedStdout = projectStream(stdout, perStream);
  const projectedStderr = projectStream(stderr, perStream);
  return {
    stdout: projectedStdout.text,
    stderr: projectedStderr.text,
    stdoutComplete: projectedStdout.complete,
    stderrComplete: projectedStderr.complete,
    modelCharacters: projectedStdout.text.length + projectedStderr.text.length,
  };
}

async function decryptStream(state: StreamState): Promise<string> {
  if (state.failed) throw state.failed;
  const cipherEnded = awaitEvent(state.cipher, "end");
  state.cipher.end();
  await cipherEnded;
  const tag = state.cipher.getAuthTag();
  const outputClosed = awaitEvent(state.output, "close");
  state.output.write(tag);
  state.output.end();
  await outputClosed;

  const stat = await fs.stat(state.filePath);
  if (stat.size < AES_IV_BYTES + AES_TAG_BYTES) {
    throw new Error("encrypted shell capture is incomplete");
  }
  const file = await fs.open(state.filePath, "r");
  const storedTag = Buffer.alloc(AES_TAG_BYTES);
  await file.read(storedTag, 0, AES_TAG_BYTES, stat.size - AES_TAG_BYTES);
  await file.close();
  const iv = Buffer.alloc(AES_IV_BYTES);
  const ivFile = await fs.open(state.filePath, "r");
  await ivFile.read(iv, 0, AES_IV_BYTES, 0);
  await ivFile.close();
  const decipher = createDecipheriv("aes-256-gcm", state.key, iv);
  decipher.setAuthTag(storedTag);
  const chunks: Buffer[] = [];
  decipher.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const decipherEnded = awaitEvent(decipher, "end");
  if (stat.size === AES_IV_BYTES + AES_TAG_BYTES) {
    decipher.end();
  } else {
    createReadStream(state.filePath, {
      start: AES_IV_BYTES,
      end: stat.size - AES_TAG_BYTES - 1,
    }).pipe(decipher);
  }
  await decipherEnded;
  const text = Buffer.concat(chunks).toString("utf8");
  if (toWellFormedUnicode(text) !== text) {
    throw new Error("shell capture contains malformed Unicode");
  }
  return text;
}

export class ForegroundShellCapture {
  readonly directory: string;
  private readonly streams: Record<CaptureStreamName, StreamState>;
  private finalized = false;

  private constructor(
    directory: string,
    streams: Record<CaptureStreamName, StreamState>,
  ) {
    this.directory = directory;
    this.streams = streams;
  }

  static async create(): Promise<ForegroundShellCapture> {
    const root = await ensureCaptureRoot();
    const directory = path.join(root, `.capture-${randomUUID()}`);
    await fs.mkdir(directory, { mode: 0o700 });
    return new ForegroundShellCapture(directory, {
      stdout: await createStreamState(directory, "stdout"),
      stderr: await createStreamState(directory, "stderr"),
    });
  }

  write(stream: CaptureStreamName, chunk: string): boolean {
    if (this.finalized) throw new Error("shell capture is already finalized");
    const state = this.streams[stream];
    state.endedWithNewline = updateMetrics(
      state.metrics,
      chunk,
      state.endedWithNewline,
    );
    return state.cipher.write(chunk, "utf8");
  }

  onDrain(stream: CaptureStreamName, listener: () => void): void {
    this.streams[stream].cipher.once("drain", listener);
  }

  async finalize(
    runtime: IAgentRuntime,
    outcome: ShellCaptureOutcome,
  ): Promise<FinalizedShellCapture> {
    if (this.finalized) throw new Error("shell capture is already finalized");
    this.finalized = true;
    try {
      const [rawStdout, rawStderr] = await Promise.all([
        decryptStream(this.streams.stdout),
        decryptStream(this.streams.stderr),
      ]);
      const stdout = redactShellText(runtime, rawStdout);
      const stderr = redactShellText(runtime, rawStderr);
      const projection = projectionFor(stdout, stderr);
      const artifact = await persistShellOutputArtifact({
        stdout,
        stderr,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        signal: outcome.signal,
        modelCharacterLimit: MODEL_PROJECTION_LIMIT_CHARS,
        modelCharacters: projection.modelCharacters,
        ownerAgentId: outcome.ownerAgentId,
        ownerConversationId: outcome.ownerConversationId,
        sourceStdout: this.streams.stdout.metrics,
        sourceStderr: this.streams.stderr.metrics,
      });
      return { artifact, projection };
    } finally {
      for (const state of Object.values(this.streams)) state.key.fill(0);
      await fs.rm(this.directory, { recursive: true, force: true });
    }
  }

  async abort(): Promise<void> {
    if (!this.finalized) {
      this.finalized = true;
      for (const state of Object.values(this.streams)) {
        state.key.fill(0);
        state.cipher.destroy();
        state.output.destroy();
      }
    }
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}
