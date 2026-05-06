import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  fetchRemoteMedia,
  type GenerateTextParams,
  type IAgentRuntime,
  type ImageDescriptionParams,
  type ImageDescriptionResult,
  type LookupFn,
  logger,
} from "@elizaos/core";
import { readConfigEnvKey } from "./config-env.js";

const TRUE_VALUE = /^(1|true|yes|on)$/i;
const FALSE_VALUE = /^(0|false|no|off)$/i;
const DEFAULT_TIMEOUT_MS = 105_000;
const MAX_CAPTURE_CHARS = 16_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_LAST_MESSAGE_HELP_TIMEOUT_MS = 5_000;
const outputLastMessageSupportCache = new Map<string, Promise<boolean>>();

type CodexExecInput = {
  imagePaths?: string[];
};

export type CodexExecOptions = {
  binary: string;
  workdir: string;
  model?: string;
  reasoningEffort: string;
  timeoutMs: number;
};

function readSetting(
  runtime: IAgentRuntime | undefined,
  key: string,
): string | undefined {
  const runtimeValue = runtime?.getSetting(key);
  if (typeof runtimeValue === "string" && runtimeValue.trim()) {
    return runtimeValue.trim();
  }
  const configValue = readConfigEnvKey(key);
  if (typeof configValue === "string" && configValue.trim()) {
    return configValue.trim();
  }
  const envValue = process.env[key];
  return typeof envValue === "string" && envValue.trim()
    ? envValue.trim()
    : undefined;
}

export function isCodexModelProviderEnabled(runtime?: IAgentRuntime): boolean {
  const raw = readSetting(runtime, "PARALLAX_CODEX_MODEL_PROVIDER");
  if (!raw) return false;
  if (TRUE_VALUE.test(raw)) return true;
  if (FALSE_VALUE.test(raw)) return false;
  return false;
}

export function readCodexModelProviderPriority(
  runtime?: IAgentRuntime,
): number {
  const raw = readSetting(runtime, "PARALLAX_CODEX_MODEL_PRIORITY");
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 50;
}

export function resolveCodexExecOptions(
  runtime?: IAgentRuntime,
): CodexExecOptions {
  const timeoutRaw = readSetting(runtime, "PARALLAX_CODEX_MODEL_TIMEOUT_MS");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  return {
    binary: readSetting(runtime, "PARALLAX_CODEX_BIN") ?? "codex",
    workdir:
      readSetting(runtime, "PARALLAX_CODEX_MODEL_WORKDIR") ?? process.cwd(),
    model:
      readSetting(runtime, "PARALLAX_CODEX_MODEL") ??
      readSetting(runtime, "PARALLAX_CODEX_EXEC_MODEL"),
    reasoningEffort:
      readSetting(runtime, "PARALLAX_CODEX_MODEL_REASONING_EFFORT") ?? "low",
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : DEFAULT_TIMEOUT_MS,
  };
}

export function buildCodexExecArgs(
  outputFile: string,
  options: CodexExecOptions,
  useOutputLastMessage = true,
  input: CodexExecInput = {},
): string[] {
  const args = [
    "exec",
    "-s",
    "read-only",
    "-C",
    options.workdir,
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "-c",
    `model_reasoning_effort=${options.reasoningEffort}`,
  ];
  if (useOutputLastMessage) {
    args.push("--output-last-message", outputFile);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  for (const imagePath of input.imagePaths ?? []) {
    args.push("--image", imagePath);
  }
  args.push("-");
  return args;
}

export function promptFromGenerateTextParams(
  params: GenerateTextParams,
): string {
  if (typeof params.prompt === "string" && params.prompt.length > 0) {
    return params.prompt;
  }
  const maybeMessages = (params as unknown as { messages?: unknown }).messages;
  if (Array.isArray(maybeMessages)) {
    return maybeMessages
      .map((message) => {
        if (!message || typeof message !== "object") return String(message);
        const record = message as Record<string, unknown>;
        const role = typeof record.role === "string" ? record.role : "message";
        const content =
          typeof record.content === "string"
            ? record.content
            : JSON.stringify(record.content);
        return `${role}: ${content}`;
      })
      .join("\n\n");
  }
  return JSON.stringify(params);
}

export function buildCodexModelPrompt(
  params: GenerateTextParams,
  modelType?: string,
): string {
  const responseFormat =
    typeof params.responseFormat === "string"
      ? params.responseFormat
      : params.responseFormat?.type;
  const formatHint = responseFormat
    ? `The requested response format is ${responseFormat}.`
    : "Use the response format requested by the prompt.";
  return [
    "You are running as a non-interactive elizaOS model provider.",
    "Use the prompt below as the complete task. Do not inspect local files or run shell commands unless the prompt explicitly asks for local filesystem facts.",
    "Return only the final model output. No labels, no status text, no markdown fences unless the prompt explicitly asks for markdown.",
    modelType ? `Model type: ${modelType}.` : "",
    formatHint,
    "",
    "<eliza_prompt>",
    promptFromGenerateTextParams(params),
    "</eliza_prompt>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCodexImageDescriptionPrompt(
  params: ImageDescriptionParams | string,
): string {
  const prompt =
    typeof params === "string"
      ? "Describe this image accurately."
      : params.prompt?.trim() || "Describe this image accurately.";
  return [
    "You are running as a non-interactive elizaOS IMAGE_DESCRIPTION model provider.",
    "Use only the attached image content and the user prompt below.",
    "Do not run shell commands, inspect files, mention file paths, or include implementation details.",
    'Return JSON only, with this shape: {"title":"short title","description":"natural language description"}.',
    "",
    "<user_prompt>",
    prompt,
    "</user_prompt>",
  ].join("\n");
}

export function parseCodexImageDescriptionResult(
  text: string,
): ImageDescriptionResult {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const description =
      typeof parsed.description === "string" ? parsed.description.trim() : "";
    if (title || description) {
      return {
        title: title || "Image Analysis",
        description: description || title,
      };
    }
  } catch {
    // Plain text is acceptable; older Codex CLI builds do not always honor JSON-only prompts.
  }

  const firstLine = cleaned
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  return {
    title: firstLine?.slice(0, 80) || "Image Analysis",
    description: cleaned || "Image description unavailable.",
  };
}

function appendCapture(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (next.length <= MAX_CAPTURE_CHARS) return next;
  return next.slice(next.length - MAX_CAPTURE_CHARS);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

function codexSupportsOutputLastMessage(binary: string): Promise<boolean> {
  const cached = outputLastMessageSupportCache.get(binary);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
    const child = spawn(binary, ["exec", "--help"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(supported);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, OUTPUT_LAST_MESSAGE_HELP_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      output = appendCapture(output, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = appendCapture(output, chunk);
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(output.includes("--output-last-message")));
  });

  outputLastMessageSupportCache.set(binary, probe);
  return probe;
}

export async function runCodexExec(
  prompt: string,
  options: CodexExecOptions,
  input: CodexExecInput = {},
): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "eliza-codex-model-"));
  const outputFile = path.join(tempDir, `${randomUUID()}.txt`);
  const supportsOutputLastMessage = await codexSupportsOutputLastMessage(
    options.binary,
  );
  const args = buildCodexExecArgs(
    outputFile,
    options,
    supportsOutputLastMessage,
    input,
  );
  let stdout = "";
  let stderr = "";

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.binary, args, {
        cwd: options.workdir,
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanupTimers = () => {
        clearTimeout(timer);
        if (escalationTimer) {
          clearTimeout(escalationTimer);
          escalationTimer = undefined;
        }
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        fn();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        escalationTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, KILL_GRACE_MS);
        reject(
          new Error(
            `codex exec timed out after ${options.timeoutMs}ms for model provider call`,
          ),
        );
      }, options.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendCapture(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendCapture(stderr, chunk);
      });
      child.stdin.on("error", (error) => {
        if (settled) return;
        if (errorCode(error) === "EPIPE") {
          stderr = appendCapture(stderr, Buffer.from(error.message));
          return;
        }
        settle(() => reject(error));
      });
      child.on("error", (error) => {
        cleanupTimers();
        if (settled) return;
        settle(() => reject(error));
      });
      child.on("close", (code, signal) => {
        cleanupTimers();
        if (settled) return;
        if (code === 0) {
          settle(resolve);
          return;
        }
        settle(() =>
          reject(
            new Error(
              `codex exec exited with code ${code ?? "null"} signal ${
                signal ?? "null"
              }. ${stderr || stdout}`.trim(),
            ),
          ),
        );
      });

      child.stdin.end(prompt);
    });

    const finalMessage = supportsOutputLastMessage
      ? await readFile(outputFile, "utf8")
          .then((value) => value.trim())
          .catch((error) => {
            throw new Error(
              `codex exec did not write --output-last-message output (${error instanceof Error ? error.message : String(error)}). ${stderr || stdout}`.trim(),
            );
          })
      : stdout.trim();
    if (!finalMessage) {
      throw new Error(
        `codex exec produced an empty model response. ${stderr || stdout}`.trim(),
      );
    }
    return finalMessage;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function imageUrlFromParams(params: ImageDescriptionParams | string): string {
  if (typeof params === "string") return params.trim();
  return params.imageUrl.trim();
}

function imageExtensionForMime(mime: string | undefined): string {
  if (!mime) return "";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".img";
}

function imageExtensionForUrl(url: URL): string {
  const extension = path.extname(url.pathname).toLowerCase();
  if ([".gif", ".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
    return extension;
  }
  return "";
}

const nodeLookup: LookupFn = async (hostname, options) => {
  const records = await dnsLookup(hostname, options);
  return records.map((record) => ({
    address: record.address,
    family: record.family,
  }));
};

async function imageFetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    IMAGE_FETCH_TIMEOUT_MS,
  );
  const upstreamSignal = init?.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, {
        once: true,
      });
    }
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function decodePercentEncodedBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "%") {
      const hex = value.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        throw new Error(
          "IMAGE_DESCRIPTION data URL has invalid percent encoding",
        );
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code > 0x7f) {
      throw new Error(
        "IMAGE_DESCRIPTION non-base64 data URLs must use percent-encoded bytes",
      );
    }
    bytes.push(code);
  }
  return Buffer.from(bytes);
}

async function writeDataUrlImage(
  imageUrl: string,
  tempDir: string,
): Promise<string> {
  const match = imageUrl.match(/^data:([^,]*),(.*)$/s);
  if (!match) {
    throw new Error(
      "IMAGE_DESCRIPTION requires an http(s) URL or image data URL",
    );
  }
  const metadata = (match[1] ?? "").split(";").filter(Boolean);
  const mime = metadata[0]?.toLowerCase() || "text/plain";
  const isBase64 = metadata
    .slice(1)
    .some((part) => part.toLowerCase() === "base64");
  if (!mime?.startsWith("image/")) {
    throw new Error(
      `IMAGE_DESCRIPTION data URL is not an image: ${mime ?? "unknown"}`,
    );
  }
  const payload = match[2] ?? "";
  const buffer = isBase64
    ? Buffer.from(payload, "base64")
    : decodePercentEncodedBytes(payload);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`IMAGE_DESCRIPTION image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const imagePath = path.join(
    tempDir,
    `${randomUUID()}${imageExtensionForMime(mime)}`,
  );
  await writeFile(imagePath, buffer);
  return imagePath;
}

async function downloadImageUrl(
  imageUrl: string,
  tempDir: string,
): Promise<string> {
  if (imageUrl.startsWith("data:")) {
    return writeDataUrlImage(imageUrl, tempDir);
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error(
      "IMAGE_DESCRIPTION requires an http(s) URL or image data URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `IMAGE_DESCRIPTION does not support ${parsed.protocol} URLs`,
    );
  }

  let buffer: Buffer;
  let contentType: string | undefined;
  try {
    const result = await fetchRemoteMedia({
      url: parsed.toString(),
      fetchImpl: imageFetchWithTimeout,
      maxBytes: MAX_IMAGE_BYTES,
      maxRedirects: 3,
      lookupFn: nodeLookup,
    });
    buffer = result.buffer;
    contentType = result.contentType?.split(";")[0]?.trim().toLowerCase();
  } catch (error) {
    throw new Error(
      `IMAGE_DESCRIPTION image fetch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (contentType && !contentType.startsWith("image/")) {
    throw new Error(`IMAGE_DESCRIPTION URL is not an image: ${contentType}`);
  }
  const imagePath = path.join(
    tempDir,
    `${randomUUID()}${imageExtensionForMime(contentType) || imageExtensionForUrl(parsed)}`,
  );
  await writeFile(imagePath, buffer);
  return imagePath;
}

export async function codexCliImageDescriptionModel(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string,
): Promise<ImageDescriptionResult> {
  const imageUrl = imageUrlFromParams(params);
  if (!imageUrl) {
    throw new Error("IMAGE_DESCRIPTION requires a valid image URL");
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "eliza-codex-image-"));
  try {
    const imagePath = await downloadImageUrl(imageUrl, tempDir);
    const options = resolveCodexExecOptions(runtime);
    logger.info(
      `[codex-model-provider] running codex exec for IMAGE_DESCRIPTION in ${options.workdir}`,
    );
    const text = await runCodexExec(
      buildCodexImageDescriptionPrompt(params),
      options,
      {
        imagePaths: [imagePath],
      },
    );
    return parseCodexImageDescriptionResult(text);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function codexCliTextModel(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  const rawModelType = (params as unknown as { modelType?: unknown }).modelType;
  const modelType = typeof rawModelType === "string" ? rawModelType : undefined;
  const options = resolveCodexExecOptions(runtime);
  const prompt = buildCodexModelPrompt(params, modelType);
  logger.info(
    `[codex-model-provider] running codex exec for ${modelType ?? "text"} in ${options.workdir}`,
  );
  return runCodexExec(prompt, options);
}
