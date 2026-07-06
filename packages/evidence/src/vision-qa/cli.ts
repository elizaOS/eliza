/**
 * `vision-qa ask` CLI: a thin wrapper over `askAboutImage`. It parses argv,
 * optionally runs `suggestQuestions` over a `--context analysis.json` and merges
 * those with `-q` questions, calls the API, and prints a readable answer table
 * (or the raw JSON with `--json`). Like the bundle CLI, this file is a process
 * boundary: writing to the injected stdout/stderr is the product, the library
 * never logs, and tests call `runVisionQaCli` directly with a captured writer.
 * A NOT_CONFIGURED environment exits non-zero with a clear message — it never
 * prints a fabricated answer.
 */

import fs from "node:fs";
import path from "node:path";
import { EvidenceError } from "../errors.ts";
import { askAboutImage } from "./ask.ts";
import { suggestQuestions } from "./suggest.ts";
import type {
  AskOptions,
  AskResult,
  VisionBackend,
  VisionQuestion,
} from "./types.ts";

const USAGE = `Usage:
  vision-qa ask <image> -q "question" [-q "question" ...] [options]

Options:
  -q, --question <text>   A question to ask (repeatable). Auto-assigned ids q1, q2, …
      --context <file>    analysis.json; suggested questions are merged in front of -q
      --backend <name>    anthropic | openai | local (else resolved from env)
      --model <id>        Override the backend's default model
      --base-url <url>    Base URL for the openai-compatible/local path
      --api-key <key>     API key override (else the backend's env var)
      --no-cache          Bypass the content-addressed cache
      --view <name>       View/surface name, used when suggesting questions
      --json              Print the raw JSON result instead of a table`;

/** Output sinks; injectable so tests capture instead of spawning. */
export interface VisionQaCliIo {
  out(line: string): void;
  err(line: string): void;
}

interface AskArgs {
  imagePath: string;
  questions: VisionQuestion[];
  contextFile?: string;
  viewName?: string;
  json: boolean;
  options: AskOptions;
}

function parseAskArgs(argv: string[]): AskArgs {
  let imagePath: string | undefined;
  const questionTexts: string[] = [];
  let contextFile: string | undefined;
  let viewName: string | undefined;
  let json = false;
  const options: AskOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new EvidenceError(`${arg} requires a value`, {
          code: "CLI_USAGE",
        });
      }
      index += 1;
      return next;
    };
    if (arg === "-q" || arg === "--question") {
      questionTexts.push(value());
    } else if (arg === "--context") {
      contextFile = value();
    } else if (arg === "--backend") {
      options.backend = value() as VisionBackend;
    } else if (arg === "--model") {
      options.model = value();
    } else if (arg === "--base-url") {
      options.baseUrl = value();
    } else if (arg === "--api-key") {
      options.apiKey = value();
    } else if (arg === "--no-cache") {
      options.noCache = true;
    } else if (arg === "--view") {
      viewName = value();
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new EvidenceError(`unknown argument: ${arg}`, {
        code: "CLI_USAGE",
      });
    } else if (imagePath === undefined) {
      imagePath = arg;
    } else {
      throw new EvidenceError(`unexpected argument: ${arg}`, {
        code: "CLI_USAGE",
      });
    }
  }

  if (imagePath === undefined) {
    throw new EvidenceError("ask requires an image path", {
      code: "CLI_USAGE",
    });
  }
  const questions: VisionQuestion[] = questionTexts.map((question, i) => ({
    id: `q${i + 1}`,
    question,
  }));
  return { imagePath, questions, contextFile, viewName, json, options };
}

/**
 * Read the `--context` analysis file and derive suggested questions. Parse
 * failures throw typed (J3): a malformed context file is operator error, not a
 * reason to silently ask fewer questions. Suggested ids are namespaced so they
 * never collide with the `q1..qN` hand-written ids.
 */
function loadContextQuestions(
  contextFile: string,
  viewName: string | undefined,
): VisionQuestion[] {
  let raw: string;
  try {
    raw = fs.readFileSync(contextFile, "utf8");
  } catch (error) {
    throw new EvidenceError(`--context file unreadable: ${contextFile}`, {
      code: "CLI_USAGE",
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new EvidenceError(`--context is not valid JSON: ${contextFile}`, {
      code: "CLI_USAGE",
      cause: error,
    });
  }
  return suggestQuestions(parsed as Parameters<typeof suggestQuestions>[0], {
    ...(viewName !== undefined ? { viewName } : {}),
  });
}

function printTable(
  io: VisionQaCliIo,
  questions: VisionQuestion[],
  result: AskResult,
): void {
  const byId = new Map(result.answers.map((a) => [a.id, a]));
  io.out(
    `backend=${result.provenance.backend} model=${result.provenance.model} ` +
      `cached=${result.provenance.cached} retries=${result.provenance.retries} ` +
      `tokens=${result.provenance.usage.inputTokens}in/${result.provenance.usage.outputTokens}out ` +
      `latency=${result.provenance.latencyMs}ms`,
  );
  io.out("");
  for (const question of questions) {
    const answer = byId.get(question.id);
    io.out(`[${question.id}] ${question.question}`);
    if (answer === undefined) {
      io.out("  (no answer returned)");
      continue;
    }
    io.out(`  answer:     ${answer.answer}`);
    io.out(`  confidence: ${answer.confidence.toFixed(2)}`);
    io.out(`  details:    ${answer.details}`);
    io.out("");
  }
}

async function runAsk(argv: string[], io: VisionQaCliIo): Promise<number> {
  const args = parseAskArgs(argv);
  const suggested = args.contextFile
    ? loadContextQuestions(args.contextFile, args.viewName)
    : [];
  const questions = [...suggested, ...args.questions];
  if (questions.length === 0) {
    throw new EvidenceError(
      "no questions: pass -q or a --context that yields suggestions",
      { code: "CLI_USAGE" },
    );
  }
  const result = await askAboutImage(args.imagePath, questions, args.options);
  if (args.json) {
    io.out(JSON.stringify({ questions, ...result }, null, 2));
  } else {
    printTable(io, questions, result);
  }
  return 0;
}

/** Parse argv (without node/script prefix) and run; returns the exit code. */
export async function runVisionQaCli(
  argv: string[],
  io: VisionQaCliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "ask") return await runAsk(rest, io);
    io.err(USAGE);
    return command === undefined || command === "--help" || command === "-h"
      ? 0
      : 1;
  } catch (error) {
    // error-policy:J1 process boundary — translate typed failures into a
    // structured stderr line + non-zero exit for the invoking harness.
    if (error instanceof EvidenceError) {
      io.err(`error [${error.code}]: ${error.message}`);
      if (error.code === "CLI_USAGE") io.err(USAGE);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const io: VisionQaCliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  process.exitCode = await runVisionQaCli(process.argv.slice(2), io);
}
