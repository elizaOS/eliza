import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * Bun arguments for a speech worker. A source checkout resolves the worker
 * to its `.ts` file, which needs the `eliza-source` condition to load
 * workspace sources. A packaged build resolves the bundled `.js` worker, which
 * must resolve its external dependencies from their built `dist` files, so the
 * condition is not passed there.
 */
export function speechWorkerArgs(workerPath: string): string[] {
  return [
    "--no-install",
    ...(workerPath.endsWith(".ts") ? ["--conditions=eliza-source"] : []),
    workerPath,
  ];
}

interface PendingRequest<Result> {
  id: string;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  grace?: ReturnType<typeof setTimeout>;
}

/** How long a worker may take to answer a native cancel before it is killed. */
export const SPEECH_CANCEL_GRACE_MS = 10_000;

/**
 * One initialized host speech worker on libelizainference. The worker runs one
 * request at a time. Cancelling a request asks the worker to cancel the native
 * call; the caller is released at once, and the worker is killed only if it
 * does not answer within `SPEECH_CANCEL_GRACE_MS`. Cancelling cold startup
 * kills the worker.
 */
export abstract class StandaloneSpeechService<Result> {
  private child?: ChildProcess;
  private boot?: Promise<void>;
  private ready = false;
  private pending?: PendingRequest<Result>;
  private rejectBoot?: (error: Error) => void;
  /** Absolute path of the worker module to spawn. */
  protected abstract workerPath(): string;
  /** Environment variables the worker may read. */
  protected abstract readonly environment: readonly string[];
  /** Validate one worker result; throw to treat the worker as broken. */
  protected abstract decode(value: Record<string, unknown>): Result;
  /** Message for a request the worker reported as failed. */
  protected abstract readonly failure: string;
  /** Upper bound for one request, after which it is cancelled. */
  protected abstract readonly deadlineMs: number;
  /** Upper bound for one protocol line from the worker. */
  protected abstract readonly maxResultBytes: number;

  get busy() {
    return !!this.pending;
  }
  get initialized() {
    return this.ready;
  }
  stop() {
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    this.boot = undefined;
    this.rejectBoot?.(Error("Speech worker stopped"));
    this.rejectBoot = undefined;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending?.grace);
    pending?.reject(Error("Speech worker stopped"));
    child?.kill("SIGKILL");
  }
  async initialize() {
    if (this.ready) return;
    if (this.boot) return this.boot;
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "LANG", ...this.environment].flatMap((key) => {
        const value = process.env[key];
        return value ? [[key, value]] : [];
      }),
    );
    const child = spawn(process.execPath, speechWorkerArgs(this.workerPath()), {
      env,
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    this.child = child;
    const work = new Promise<void>((resolve, reject) => {
      this.rejectBoot = reject;
      let text = "";
      // The host lifecycle and the request caller own cancellation. Cold
      // loading has no independent deadline before its readiness probe.
      const failed = () => {
        if (this.child === child) this.stop();
      };
      child.once("error", failed);
      child.once("exit", failed);
      child.stdin?.on("error", failed);
      const output = child.stdio[3] as Readable;
      output.on("error", failed);
      output.once("end", failed);
      output.once("close", failed);
      output.on("data", (bytes: Buffer) => {
        if (this.child !== child) return;
        text += bytes.toString("utf8");
        if (text.length > this.maxResultBytes + 1024) {
          failed();
          return;
        }
        for (
          let newline = text.indexOf("\n");
          newline >= 0;
          newline = text.indexOf("\n")
        ) {
          const line = text.slice(0, newline);
          text = text.slice(newline + 1);
          try {
            const value = JSON.parse(line);
            if (!this.ready) {
              if (value.ready !== true) throw Error("Invalid readiness");
              this.ready = true;
              this.rejectBoot = undefined;
              resolve();
              continue;
            }
            const pending = this.pending;
            if (!pending || value.id !== pending.id)
              throw Error("Unexpected speech result");
            clearTimeout(pending.grace);
            if (typeof value.error === "string") {
              this.pending = undefined;
              pending.reject(
                Error(
                  value.error === "cancelled"
                    ? "Speech cancelled"
                    : this.failure,
                ),
              );
              continue;
            }
            const result = this.decode(value);
            this.pending = undefined;
            pending.resolve(result);
          } catch {
            failed();
            return;
          }
        }
      });
    });
    this.boot = work;
    try {
      await work;
    } catch (error) {
      if (this.child === child) this.stop();
      throw error;
    }
  }
  /** Send one request and wait for its result. */
  protected async request(
    id: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Result> {
    signal.throwIfAborted();
    const cancelInit = () => this.stop();
    signal.addEventListener("abort", cancelInit, { once: true });
    try {
      await this.initialize();
    } finally {
      signal.removeEventListener("abort", cancelInit);
    }
    signal.throwIfAborted();
    if (this.pending) throw Error("Speech is busy");
    const child = this.child;
    const input = child?.stdin;
    if (!child || !input) throw Error("Speech worker is unavailable");
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener("abort", cancel);
        finish();
      };
      const pending: PendingRequest<Result> = {
        id,
        resolve: (result) =>
          settle(() =>
            signal.aborted
              ? reject(Error("Speech cancelled"))
              : resolve(result),
          ),
        reject: (error) => settle(() => reject(error)),
      };
      // Release the caller now; the worker stays busy until it answers.
      const cancel = () => {
        if (this.pending !== pending || this.child !== child) return;
        settle(() => reject(Error("Speech cancelled")));
        pending.grace = setTimeout(() => {
          if (this.pending === pending && this.child === child) this.stop();
        }, SPEECH_CANCEL_GRACE_MS);
        input.write(`${JSON.stringify({ id, op: "cancel" })}\n`, (error) => {
          if (error && this.child === child) this.stop();
        });
      };
      const deadline = setTimeout(cancel, this.deadlineMs);
      this.pending = pending;
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      input.write(`${JSON.stringify({ ...payload, id })}\n`, (error) => {
        if (error && this.child === child) this.stop();
      });
    });
  }
}

/** Largest WAV the TTS worker returns: 60 s of mono PCM16 at 24 kHz. */
const MAX_WAV_BYTES = 44 + 60 * 24000 * 2;

/** Paradee-8M speech output through `host-tts-worker`. */
export class StandaloneTtsService extends StandaloneSpeechService<Buffer> {
  protected readonly environment = [
    "ELIZA_INFERENCE_LIBRARY",
    "ELIZA_INFERENCE_LIBRARY_SHA256",
    "ELIZA_PARADEE_MODEL_DIR",
  ];
  protected readonly failure = "Speech synthesis failed";
  protected readonly deadlineMs = 60_000;
  protected readonly maxResultBytes = Math.ceil(MAX_WAV_BYTES / 3) * 4 + 64;
  protected workerPath() {
    return fileURLToPath(
      import.meta.resolve("@elizaos/plugin-local-inference/host-tts-worker"),
    );
  }
  protected decode(value: Record<string, unknown>) {
    if (
      typeof value.audio !== "string" ||
      value.audio.length > this.maxResultBytes
    )
      throw Error("Invalid speech output");
    const audio = Buffer.from(value.audio, "base64");
    if (
      audio.length < 44 ||
      audio.length > MAX_WAV_BYTES ||
      audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 12) !== "WAVE" ||
      audio.toString("base64") !== value.audio
    )
      throw Error("Invalid speech WAV");
    return audio;
  }
  synthesize(id: string, text: string, signal: AbortSignal) {
    return this.request(id, { op: "synthesize", text }, signal);
  }
}
