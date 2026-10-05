/** Explicit host whisper.cpp provider; independent of fused/bundle ASR and text routing. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveAuthorizedRouteRole } from "./auth";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson } from "./response";

const MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER = "standalone-whisper.cpp";
const MODEL_SHA =
  "4baf807ea95de42a7f9df96e24a36fe835ac8fb5b6ca20d7539ef521c42e6a2b";
let active = false;
let decoding = false;
const seen = new Map<string, number>();
class VoiceFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
async function configuration() {
  if (process.env.ELIZA_WHISPER_ENABLED !== "1") return null;
  const backend = process.env.ELIZA_WHISPER_BACKEND ?? "cpu";
  if (backend !== "cpu" && backend !== "auto") return null;
  const binary = process.env.ELIZA_WHISPER_BINARY,
    model = process.env.ELIZA_WHISPER_MODEL,
    binarySha = process.env.ELIZA_WHISPER_BINARY_SHA256;
  if (
    !binary ||
    !model ||
    !isAbsolute(binary) ||
    !isAbsolute(model) ||
    !/^[a-f0-9]{64}$/.test(binarySha ?? "")
  )
    return null;
  try {
    const [bs, ms] = await Promise.all([stat(binary), stat(model)]);
    if (
      !bs.isFile() ||
      !ms.isFile() ||
      bs.size > 32 * 1024 * 1024 ||
      ms.size !== 77704698
    )
      return null;
    await access(binary, constants.X_OK);
    const [binaryData, modelData] = await Promise.all([
      readFile(binary),
      readFile(model),
    ]);
    if (
      createHash("sha256").update(binaryData).digest("hex") !== binarySha ||
      createHash("sha256").update(modelData).digest("hex") !== MODEL_SHA
    )
      return null;
    return { binary, model, binarySha, modelSha: MODEL_SHA, backend };
  } catch {
    return null;
  }
}
function validateWav(bytes: Buffer): number {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw new VoiceFailure(422, "invalid_pcm_wav");
  let format = false,
    samples: Buffer | undefined;
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length)
      throw new VoiceFailure(422, "invalid_pcm_wav");
    const length = bytes.readUInt32LE(offset + 4),
      begin = offset + 8,
      end = begin + length;
    if (end > bytes.length) throw new VoiceFailure(422, "invalid_pcm_wav");
    const kind = bytes.toString("ascii", offset, offset + 4);
    if (kind === "fmt ") {
      if (
        format ||
        length < 16 ||
        bytes.readUInt16LE(begin) !== 1 ||
        bytes.readUInt16LE(begin + 2) !== 1 ||
        bytes.readUInt32LE(begin + 4) !== 16000 ||
        bytes.readUInt32LE(begin + 8) !== 32000 ||
        bytes.readUInt16LE(begin + 12) !== 2 ||
        bytes.readUInt16LE(begin + 14) !== 16
      )
        throw new VoiceFailure(422, "requires_mono_pcm16_16000");
      format = true;
    }
    if (kind === "data") {
      if (samples) throw new VoiceFailure(422, "invalid_pcm_wav");
      samples = bytes.subarray(begin, end);
    }
    offset = end + (length % 2);
  }
  if (
    !format ||
    !samples?.length ||
    samples.length % 2 ||
    samples.length > 60 * 32000
  )
    throw new VoiceFailure(422, "audio_duration_invalid");
  let nonzero = false;
  for (let i = 0; i < samples.length; i += 2)
    if (samples.readInt16LE(i) !== 0) {
      nonzero = true;
      break;
    }
  if (!nonzero) throw new VoiceFailure(422, "no_speech");
  return samples.length / 32000;
}
async function bytesFrom(req: http.IncomingMessage, signal: AbortSignal) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BYTES)
    throw new VoiceFailure(413, "audio_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    signal.throwIfAborted();
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) throw new VoiceFailure(413, "audio_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
async function decode(
  config: NonNullable<Awaited<ReturnType<typeof configuration>>>,
  bytes: Buffer,
  signal: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), "eliza-whisper-"));
  await chmod(directory, 0o700);
  try {
    const input = join(directory, "input.wav"),
      output = join(directory, "transcript");
    await writeFile(input, bytes, { mode: 0o600 });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        config.binary,
        [
          "-m",
          config.model,
          "-f",
          input,
          "-l",
          "en",
          "-t",
          "4",
          ...(config.backend === "cpu" ? ["-ng"] : []),
          "-nt",
          "-np",
          "-otxt",
          "-of",
          output,
        ],
        {
          stdio: "ignore",
          cwd: directory,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
        },
      );
      decoding = !!child.pid;
      let timedOut = false;
      const cancel = () => child.kill("SIGKILL");
      const timer = setTimeout(() => {
        timedOut = true;
        cancel();
      }, 90000);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const cleanup = () => {
        decoding = false;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      child.once("error", () => {
        cleanup();
        reject(new VoiceFailure(503, "provider_unavailable"));
      });
      child.once("close", (code) => {
        cleanup();
        if (signal.aborted) reject(new VoiceFailure(499, "cancelled"));
        else if (timedOut)
          reject(new VoiceFailure(504, "transcription_timeout"));
        else if (code !== 0)
          reject(new VoiceFailure(502, "transcription_failed"));
        else resolve();
      });
    });
    signal.throwIfAborted();
    if ((await stat(`${output}.txt`)).size > 64000)
      throw new VoiceFailure(502, "transcript_too_large");
    const text = (await readFile(`${output}.txt`, "utf8")).trim();
    if (
      !text ||
      text.length > 16000 ||
      /^(?:\[\s*(?:blank_audio|silence|no speech)\s*\]\s*)+$/i.test(text)
    )
      throw new VoiceFailure(422, "no_speech");
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function handleStandaloneWhisperRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const status = req.method === "GET" && path === "/api/asr/whisper/status";
  if (!status && !(req.method === "POST" && path === "/api/asr/whisper"))
    return false;
  const identity = await resolveAuthorizedRouteRole(req, {
    state,
    allowTrustedLocalBypass: false,
  });
  if (!identity.ok) {
    sendJson(res, identity.status, { error: identity.reason });
    return true;
  }
  if (identity.role !== "OWNER" || !identity.identityId) {
    sendJson(res, 403, { error: "paired_owner_required" });
    return true;
  }
  const config = await configuration();
  if (status) {
    sendJson(res, 200, {
      ready: !!config,
      provider: PROVIDER,
      model: "tiny.en",
      backend: config?.backend ?? null,
      language: "en",
      format: "pcm16-wav",
      sampleRate: 16000,
      maxDurationSeconds: 60,
      busy: active,
      decoding,
      ...(config
        ? { modelSha256: config.modelSha, executableSha256: config.binarySha }
        : {}),
    });
    return true;
  }
  if (!config) {
    sendJson(res, 503, { error: "provider_not_configured" });
    return true;
  }
  const id = req.headers["x-request-id"];
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    sendJson(res, 400, { error: "request_id_required" });
    return true;
  }
  const key = `${identity.identityId}:${id}`,
    now = Date.now();
  for (const [entry, expiry] of seen) if (expiry < now) seen.delete(entry);
  if (seen.has(key)) {
    sendJson(res, 409, { error: "duplicate_request" });
    return true;
  }
  if (active || seen.size >= 256) {
    sendJson(res, 429, { error: "provider_busy" });
    return true;
  }
  if (!/^audio\/(?:x-)?wav(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
    sendJson(res, 415, { error: "pcm_wav_required" });
    return true;
  }
  seen.set(key, now + 600000);
  active = true;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", closed);
  const deadline = setTimeout(() => {
    abort();
    req.destroy();
  }, 100000);
  try {
    const bytes = await bytesFrom(req, controller.signal),
      durationSeconds = validateWav(bytes);
    const text = await decode(config, bytes, controller.signal);
    if (!controller.signal.aborted && !res.destroyed)
      sendJson(res, 200, {
        text,
        words: [],
        provider: PROVIDER,
        model: "tiny.en",
        language: "en",
        local: true,
        durationSeconds,
        requestId: id,
      });
  } catch (error) {
    if (!res.destroyed)
      sendJson(res, error instanceof VoiceFailure ? error.status : 422, {
        error:
          error instanceof VoiceFailure
            ? error.code
            : controller.signal.aborted
              ? "cancelled"
              : "invalid_audio",
      });
  } finally {
    clearTimeout(deadline);
    req.off("aborted", abort);
    res.off("close", closed);
    active = false;
  }
  return true;
}
