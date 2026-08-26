/**
 * Captures foreground shell streams without source-sized runtime buffers.
 *
 * Raw bytes are written only as authenticated AES-GCM ciphertext. Finalization
 * decrypts through a bounded redaction window into incremental immutable
 * segments; no source-sized plaintext or redacted string is materialized.
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
import {
  redactShellText,
  resolveShellRedactionOverlapChars,
} from "../shell/redaction.js";
import {
  type ShellOutputArtifact,
  ShellOutputArtifactWriter,
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
const REDACTION_TARGET_CHARS = 512 * 1024;
const REDACTION_OVERLAP_CHARS = 64 * 1024;
const REDACTION_MAX_PENDING_CHARS = 4 * 1024 * 1024;
const SUSPICIOUS_PATTERN_START =
  /(?:-----BEGIN |(?:Proxy-)?Authorization\s*[:=]|\bBearer\s+|--(?:api[-_]?key|token|secret|password|passwd)(?:\s+|=)|(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|MNEMONIC|SEED|CREDENTIAL)\b\s*[=:]|["'](?:apiKey|token|secret|password|passwd|accessToken|refreshToken|privateKey|clientSecret)["']\s*[:=]|\b[a-z][a-z0-9+.-]*:\/\/|\b(?:sk-|csk-|ghp_|github_pat_|xox|xapp-|gsk_|AIza|pplx-|npm_))/i;

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

class ProjectionAccumulator {
  private head = "";
  private tail = "";
  characters = 0;

  append(text: string): void {
    this.characters += text.length;
    if (this.head.length < MODEL_PROJECTION_LIMIT_CHARS) {
      this.head += text.slice(
        0,
        MODEL_PROJECTION_LIMIT_CHARS - this.head.length,
      );
    }
    this.tail = `${this.tail}${text}`.slice(-MODEL_PROJECTION_LIMIT_CHARS);
  }

  project(budget: number): { text: string; complete: boolean } {
    if (this.characters <= budget) {
      return { text: this.head.slice(0, this.characters), complete: true };
    }
    const marker =
      "\n[model projection omitted content; read the artifact for exact continuation]\n";
    const contentBudget = Math.max(2, budget - marker.length);
    const headBudget = Math.floor(contentBudget / 2);
    const tailBudget = contentBudget - headBudget;
    let head = this.head.slice(0, headBudget);
    let tail = this.tail.slice(-tailBudget);
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return {
      text: `${head}${marker}${tail}`,
      complete: false,
    };
  }
}

function projectionFor(
  stdout: ProjectionAccumulator,
  stderr: ProjectionAccumulator,
): ShellCaptureProjection {
  const active = Number(stdout.characters > 0) + Number(stderr.characters > 0);
  const perStream =
    active > 1
      ? Math.floor(MODEL_PROJECTION_LIMIT_CHARS / 2)
      : MODEL_PROJECTION_LIMIT_CHARS;
  const projectedStdout = stdout.project(perStream);
  const projectedStderr = stderr.project(perStream);
  return {
    stdout: projectedStdout.text,
    stderr: projectedStderr.text,
    stdoutComplete: projectedStdout.complete,
    stderrComplete: projectedStderr.complete,
    modelCharacters: projectedStdout.text.length + projectedStderr.text.length,
  };
}

function configuredSecretValues(runtime: IAgentRuntime): string[] {
  const configured = runtime.character?.settings?.secrets;
  if (!configured || typeof configured !== "object") return [];
  return Object.values(configured).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

class StreamingShellRedactor {
  private pending = "";
  private readonly secrets: string[];
  private readonly overlap: number;
  private readonly maximumPending: number;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly emit: (text: string) => Promise<void>,
  ) {
    this.secrets = configuredSecretValues(runtime);
    this.overlap = resolveShellRedactionOverlapChars(
      runtime,
      REDACTION_OVERLAP_CHARS,
    );
    this.maximumPending = Math.max(
      REDACTION_MAX_PENDING_CHARS,
      this.overlap * 2,
    );
  }

  async write(text: string): Promise<void> {
    if (toWellFormedUnicode(text) !== text)
      throw new Error("shell capture contains malformed Unicode");
    this.pending += text;
    while (this.pending.length > REDACTION_TARGET_CHARS + this.overlap) {
      const target = this.pending.length - this.overlap;
      let boundary = this.pending.lastIndexOf("\n", target - 1) + 1;
      if (boundary <= 0) boundary = this.safeLongRecordBoundary(target);
      boundary = this.moveBeforeCrossingSecret(boundary);
      const lastBegin = this.pending.lastIndexOf("-----BEGIN ", boundary);
      const lastEnd = this.pending.lastIndexOf("-----END ", boundary);
      if (lastBegin > lastEnd) boundary = Math.min(boundary, lastBegin);
      if (boundary <= 0) {
        if (this.pending.length > this.maximumPending) {
          throw new Error(
            "shell output contains an unbounded sensitive record that cannot be redacted safely",
          );
        }
        return;
      }
      const ready = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary);
      await this.emit(redactShellText(this.runtime, ready));
    }
  }

  async finish(): Promise<void> {
    const ready = this.pending;
    this.pending = "";
    await this.emit(redactShellText(this.runtime, ready));
  }

  private moveBeforeCrossingSecret(boundary: number): number {
    let safe = boundary;
    for (const secret of this.secrets) {
      const start = this.pending.lastIndexOf(
        secret,
        Math.min(boundary, this.pending.length),
      );
      if (start >= 0 && start < safe && start + secret.length > safe)
        safe = start;
    }
    return safe;
  }

  private safeLongRecordBoundary(target: number): number {
    let boundary = target;
    if (
      boundary > 0 &&
      boundary < this.pending.length &&
      /[\uD800-\uDBFF]/.test(this.pending[boundary - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(this.pending[boundary] ?? "")
    ) {
      boundary -= 1;
    }
    const contextStart = Math.max(0, boundary - this.overlap);
    const context = this.pending.slice(contextStart, boundary + this.overlap);
    const recordStart = this.pending.lastIndexOf("\n", boundary - 1) + 1;
    const left = this.pending.slice(recordStart, boundary);
    if (
      SUSPICIOUS_PATTERN_START.test(left) ||
      redactShellText(this.runtime, context) !== context
    ) {
      return 0;
    }
    return boundary;
  }
}

async function sealStream(state: StreamState): Promise<void> {
  if (state.failed) throw state.failed;
  const cipherEnded = awaitEvent(state.cipher, "end");
  state.cipher.end();
  await cipherEnded;
  const tag = state.cipher.getAuthTag();
  const outputClosed = awaitEvent(state.output, "close");
  state.output.write(tag);
  state.output.end();
  await outputClosed;
}

async function decryptStream(
  state: StreamState,
  consume: (text: string) => Promise<void>,
): Promise<void> {
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
  const source =
    stat.size === AES_IV_BYTES + AES_TAG_BYTES
      ? null
      : createReadStream(state.filePath, {
          start: AES_IV_BYTES,
          end: stat.size - AES_TAG_BYTES - 1,
          highWaterMark: 64 * 1024,
        });
  if (stat.size === AES_IV_BYTES + AES_TAG_BYTES) {
    decipher.end();
  } else {
    source?.pipe(decipher);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of decipher) {
    const text = decoder.decode(chunk as Buffer, { stream: true });
    if (text.length > 0) await consume(text);
  }
  const tail = decoder.decode();
  if (tail.length > 0) await consume(tail);
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
    if (toWellFormedUnicode(chunk) !== chunk)
      throw new Error("shell capture contains malformed Unicode");
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
    let writer: ShellOutputArtifactWriter | undefined;
    try {
      await Promise.all([
        sealStream(this.streams.stdout),
        sealStream(this.streams.stderr),
      ]);
      writer = await ShellOutputArtifactWriter.create({
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        signal: outcome.signal,
        modelCharacterLimit: MODEL_PROJECTION_LIMIT_CHARS,
        ownerAgentId: outcome.ownerAgentId,
        ownerConversationId: outcome.ownerConversationId,
        sourceStdout: this.streams.stdout.metrics,
        sourceStderr: this.streams.stderr.metrics,
      });
      const projections = {
        stdout: new ProjectionAccumulator(),
        stderr: new ProjectionAccumulator(),
      };
      const activeWriter = writer;
      await Promise.all(
        (["stdout", "stderr"] as const).map(async (stream) => {
          const redactor = new StreamingShellRedactor(runtime, async (text) => {
            projections[stream].append(text);
            await activeWriter.write(stream, text);
          });
          await decryptStream(this.streams[stream], (text) =>
            redactor.write(text),
          );
          await redactor.finish();
        }),
      );
      const projection = projectionFor(projections.stdout, projections.stderr);
      const artifact = await writer.finalize(projection.modelCharacters);
      return { artifact, projection };
    } catch (error) {
      if (writer) await writer.abort();
      throw error;
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
