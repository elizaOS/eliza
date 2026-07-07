/**
 * Coding-agent CLI vision backend: reviews a screenshot by driving an
 * already-authenticated `claude` or `codex` CLI instead of an HTTP endpoint.
 * This is the escape hatch for a very common evidence-capture reality — the
 * host has an authed coding agent (this whole repo usually runs inside one) but
 * no `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`, and no local vision server.
 *
 * The CLIs are shaped differently, so each has its own invocation and parse:
 *   - claude: `claude -p <prompt> --output-format json`; the prompt tells it to
 *     Read the image file, and the JSON envelope carries `.result` (the model's
 *     reply) and `.usage.{input_tokens,output_tokens}`.
 *   - codex: `codex exec -i <image> -o <last> --json ...`; the image attaches
 *     natively, the final message lands in the `-o` file, and real token usage
 *     comes from the `turn.completed` JSONL event on stdout.
 *
 * The strict-evidence contract is preserved end to end: the model is forced to
 * the same `{answers}` JSON shape `parseAnswers` validates, and **real** token
 * usage is required — a run whose CLI output carries no usage throws rather than
 * recording a zero-usage Q&A that would not be admissible evidence. `run` is
 * injectable so tests drive the full protocol with a fake process, no CLI or
 * network needed.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvidenceError } from "../errors.ts";
import type { BackendResponse } from "./backends.ts";
import { renderQuestionPrompt, SYSTEM_RUBRIC } from "./backends.ts";
import type { PreparedImage } from "./image.ts";
import type { TokenUsage, VisionQuestion } from "./types.ts";

/** Which coding-agent CLI drives the review. */
export type VisionCli = "claude" | "codex";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a process to completion. Injectable so tests never spawn a real CLI. */
export type ProcessRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<ProcessResult>;

const DEFAULT_TIMEOUT_MS = 180_000;

/** The reply-shape instruction appended to every CLI prompt. */
const CLI_JSON_INSTRUCTION =
  'Respond with ONLY the JSON object {"answers":[{"id":string,"answer":string,' +
  '"confidence":number,"details":string}]} — one entry per question id, no ' +
  "markdown, no code fences, no prose outside the JSON.";

function extFromMediaType(mediaType: string): string {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/webp") return ".webp";
  return ".png";
}

/** Materialize the prepared (downscaled) image so a CLI can read it by path. */
function writeTempImage(image: PreparedImage): {
  imagePath: string;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-cli-vqa-"));
  const imagePath = path.join(dir, `shot${extFromMediaType(image.mediaType)}`);
  fs.writeFileSync(imagePath, Buffer.from(image.base64, "base64"));
  return { imagePath, dir };
}

function buildPrompt(
  questions: VisionQuestion[],
  correction: string | null,
  imageInstruction: string,
): string {
  return [
    SYSTEM_RUBRIC,
    imageInstruction,
    renderQuestionPrompt(questions),
    CLI_JSON_INSTRUCTION,
    ...(correction ? [correction] : []),
  ].join("\n\n");
}

const claudeEnvelopeIssue = (detail: string) =>
  new EvidenceError(`claude CLI output was not a usable envelope: ${detail}`, {
    code: "VISION_CLI_RESPONSE",
    context: { cli: "claude" },
  });

/** Parse `claude --output-format json` stdout into text + real usage. */
export function parseClaudeEnvelope(stdout: string): BackendResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (cause) {
    throw new EvidenceError("claude CLI did not emit JSON", {
      code: "VISION_CLI_RESPONSE",
      cause,
      context: { cli: "claude", preview: stdout.slice(0, 200) },
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw claudeEnvelopeIssue("top-level value is not an object");
  }
  const env = parsed as Record<string, unknown>;
  if (env.is_error === true) {
    throw claudeEnvelopeIssue(`is_error=true (${String(env.subtype ?? "")})`);
  }
  const text = env.result;
  if (typeof text !== "string" || text.length === 0) {
    throw claudeEnvelopeIssue("missing string 'result'");
  }
  const usage = readUsage(env.usage, "input_tokens", "output_tokens");
  return { text, usage };
}

/** Parse a codex `--json` JSONL stream for the final `turn.completed` usage. */
export function parseCodexUsage(stdout: string): TokenUsage {
  let usage: TokenUsage | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // codex interleaves non-JSON log lines with JSONL events; a line that is
      // not an event is skipped, not a failure. The absence of ANY usage event
      // is what fails below.
      continue;
    }
    if (
      typeof event === "object" &&
      event !== null &&
      (event as Record<string, unknown>).type === "turn.completed"
    ) {
      usage = readUsage(
        (event as Record<string, unknown>).usage,
        "input_tokens",
        "output_tokens",
      );
    }
  }
  if (usage === null) {
    throw new EvidenceError(
      "codex CLI output carried no turn.completed usage event",
      { code: "VISION_CLI_RESPONSE", context: { cli: "codex" } },
    );
  }
  return usage;
}

/** Pull a required, non-negative-integer usage pair or throw — never estimate. */
function readUsage(
  raw: unknown,
  inputKey: string,
  outputKey: string,
): TokenUsage {
  if (typeof raw !== "object" || raw === null) {
    throw new EvidenceError("vision CLI response had no usage block", {
      code: "VISION_CLI_RESPONSE",
    });
  }
  const record = raw as Record<string, unknown>;
  const input = record[inputKey];
  const output = record[outputKey];
  if (typeof input !== "number" || typeof output !== "number") {
    throw new EvidenceError("vision CLI usage block was missing token counts", {
      code: "VISION_CLI_RESPONSE",
      context: { inputKey, outputKey },
    });
  }
  return { inputTokens: input, outputTokens: output };
}

const defaultRunner: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new EvidenceError(
            `vision CLI '${command}' timed out after ${options.timeoutMs}ms`,
            { code: "VISION_CLI_TIMEOUT", context: { command } },
          ),
        ),
      );
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() => resolve({ code, stdout, stderr })),
    );
  });

/**
 * Drives one coding-agent CLI as a vision backend. Unlike the HTTP clients it
 * cannot split into build/extract (the transport is a subprocess, not a
 * request), so `askAboutImage` special-cases it: it exposes `invoke` returning
 * the same `BackendResponse` the HTTP path yields, and the caller's retry loop
 * and usage accounting are unchanged.
 */
export class CliVisionBackend {
  readonly model: string;
  private readonly cli: VisionCli;
  private readonly command: string;
  private readonly run: ProcessRunner;

  constructor(options: {
    cli: VisionCli;
    /** Recorded in provenance; the CLI itself picks the concrete model. */
    model: string;
    /** Override the executable name (default: the cli id). */
    command?: string;
    runner?: ProcessRunner;
  }) {
    this.cli = options.cli;
    this.model = options.model;
    this.command = options.command ?? options.cli;
    this.run = options.runner ?? defaultRunner;
  }

  async invoke(
    image: PreparedImage,
    questions: VisionQuestion[],
    correction: string | null,
    opts: { timeoutMs?: number } = {},
  ): Promise<BackendResponse> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staged = writeTempImage(image);
    try {
      return this.cli === "claude"
        ? await this.invokeClaude(
            staged.imagePath,
            staged.dir,
            questions,
            correction,
            timeoutMs,
          )
        : await this.invokeCodex(
            staged.imagePath,
            staged.dir,
            questions,
            correction,
            timeoutMs,
          );
    } finally {
      fs.rmSync(staged.dir, { recursive: true, force: true });
    }
  }

  private async invokeClaude(
    imagePath: string,
    imageDir: string,
    questions: VisionQuestion[],
    correction: string | null,
    timeoutMs: number,
  ): Promise<BackendResponse> {
    const prompt = buildPrompt(
      questions,
      correction,
      `Read the image file at ${imagePath} using your Read tool, then answer strictly about what it shows.`,
    );
    // The staged image lives outside the CLI's working directory; --add-dir
    // grants read access so headless `-p` mode (which cannot prompt for
    // permission) can open it instead of denying the Read and answering blind.
    const result = await this.run(
      this.command,
      ["-p", prompt, "--output-format", "json", "--add-dir", imageDir],
      { timeoutMs },
    );
    if (result.code !== 0) {
      throw new EvidenceError(
        `claude CLI exited ${result.code}: ${result.stderr.slice(0, 300)}`,
        { code: "VISION_CLI_EXIT", context: { cli: "claude" } },
      );
    }
    return parseClaudeEnvelope(result.stdout);
  }

  private async invokeCodex(
    imagePath: string,
    dir: string,
    questions: VisionQuestion[],
    correction: string | null,
    timeoutMs: number,
  ): Promise<BackendResponse> {
    const prompt = buildPrompt(
      questions,
      correction,
      "Look at the attached image and answer strictly about what it shows.",
    );
    const lastMessagePath = path.join(dir, "last-message.txt");
    const result = await this.run(
      this.command,
      [
        "exec",
        "-i",
        imagePath,
        "-o",
        lastMessagePath,
        "--json",
        "--skip-git-repo-check",
        prompt,
      ],
      { timeoutMs },
    );
    if (result.code !== 0) {
      throw new EvidenceError(
        `codex CLI exited ${result.code}: ${result.stderr.slice(0, 300)}`,
        { code: "VISION_CLI_EXIT", context: { cli: "codex" } },
      );
    }
    let text: string;
    try {
      text = fs.readFileSync(lastMessagePath, "utf8").trim();
    } catch (cause) {
      throw new EvidenceError("codex CLI wrote no final message file", {
        code: "VISION_CLI_RESPONSE",
        cause,
        context: { cli: "codex" },
      });
    }
    if (text.length === 0) {
      throw new EvidenceError("codex CLI final message was empty", {
        code: "VISION_CLI_RESPONSE",
        context: { cli: "codex" },
      });
    }
    return { text, usage: parseCodexUsage(result.stdout) };
  }
}
