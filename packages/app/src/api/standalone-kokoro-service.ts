import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
/** One initialized host voice worker. Cancellation destroys its native context. */
/**
 * Bun arguments for the speech worker. A source checkout resolves the worker
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

export class StandaloneKokoroService {
  private child?: ChildProcess;
  private boot?: Promise<void>;
  private ready = false;
  private pending?: {
    id: string;
    resolve: (audio: Buffer) => void;
    reject: (error: Error) => void;
  };
  private rejectBoot?: (error: Error) => void;
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
    this.pending?.reject(Error("Speech worker stopped"));
    this.pending = undefined;
    child?.kill("SIGKILL");
  }
  async initialize() {
    if (this.ready) return;
    if (this.boot) return this.boot;
    const env = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "ELIZA_INFERENCE_LIBRARY",
        "ELIZA_KOKORO_MODEL_DIR",
        "ELIZA_KOKORO_LIBRARY_SHA256",
      ]
        .filter((key) => process.env[key])
        .flatMap((key) => {
          const value = process.env[key];
          return value ? [[key, value]] : [];
        }),
    );
    const child = spawn(
      process.execPath,
      speechWorkerArgs(
        fileURLToPath(
          import.meta.resolve(
            "@elizaos/plugin-local-inference/host-tts-worker",
          ),
        ),
      ),
      { env, stdio: ["pipe", "ignore", "ignore", "pipe"] },
    );
    this.child = child;
    const work = new Promise<void>((resolve, reject) => {
      this.rejectBoot = reject;
      let text = "";
      // The host lifecycle and synthesis caller own cancellation. Cold loading
      // has no independent retirement deadline before its readiness probe.
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
        if (text.length > 2 * 1024 * 1024) {
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
            if (value.error) {
              this.pending = undefined;
              pending.reject(Error("Speech synthesis failed"));
              continue;
            }
            if (typeof value.audio !== "string" || value.audio.length > 1920060)
              throw Error("Invalid speech output");
            const audio = Buffer.from(value.audio, "base64");
            if (
              audio.length < 44 ||
              audio.toString("ascii", 0, 4) !== "RIFF" ||
              audio.toString("ascii", 8, 12) !== "WAVE" ||
              audio.toString("base64") !== value.audio
            )
              throw Error("Invalid speech WAV");
            this.pending = undefined;
            pending.resolve(audio);
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
  async synthesize(id: string, text: string, signal: AbortSignal) {
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
    return new Promise<Buffer>((resolve, reject) => {
      const abort = () => this.stop();
      const timeout = setTimeout(abort, 30000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      };
      this.pending = {
        id,
        resolve: (audio) => {
          cleanup();
          if (signal.aborted) reject(Error("Speech cancelled"));
          else resolve(audio);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      input.write(`${JSON.stringify({ id, text })}\n`, (error) => {
        if (error && this.child === child) this.stop();
      });
    });
  }
}
