/**
 * LLM-tier PII sweep contract for scrub stage 4. The local sidecar engine is a
 * token-classification model (`privacy-filter-f16.gguf`) rather than chat, so
 * this module keeps the boundary span-based: engines return fragment-relative
 * offsets, the pipeline applies deterministic placeholders, and failures throw
 * instead of producing a fake clean verdict.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { CorpusMessage } from "../schema.ts";

export type PiiSweepKind = "date" | "account" | "address" | "secret";

export interface PiiSweepSpan {
  kind: PiiSweepKind;
  start: number;
  end: number;
  text: string;
  confidence: number;
  engine: string;
}

export interface PiiSweepReplacement extends PiiSweepSpan {
  replacement: string;
  valueHash: string;
}

export interface PiiSweepResult {
  message: CorpusMessage;
  replacements: PiiSweepReplacement[];
}

export interface PiiSweepEngine {
  name: string;
  classify(text: string): Promise<PiiSweepSpan[]>;
}

export interface PfCliConfig {
  binaryPath: string;
  modelPath: string;
  threshold?: number;
}

export interface EngineParityReport {
  messageCount: number;
  baselineEngine: string;
  candidateEngine: string;
  baselineSpanCount: number;
  candidateSpanCount: number;
  matchedSpanCount: number;
  missingFromCandidate: PiiSweepSpan[];
  extraInCandidate: PiiSweepSpan[];
}

const DATE_PATTERN =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const ACCOUNT_PATTERN =
  /\b(?:acct|account|routing|iban|loan)\s*(?:#|number|no\.?)?\s*[:=-]?\s*[A-Z0-9-]{6,}\b/gi;
const ADDRESS_PATTERN =
  /\b\d{2,6}\s+[A-Z][a-zA-Z0-9-]*(?:\s+[A-Z][a-zA-Z0-9-]*){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Lane|Ln|Drive|Dr)\b/g;
const SECRET_PATTERN = /\b(?:password|passcode|pin)\s*[:=-]\s*\S{4,}\b/gi;

function valueHash(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}\0${value}`).digest("hex");
}

function replacementFor(
  kind: PiiSweepKind,
  value: string,
  salt: string,
): string {
  return `[[PII:${kind}:${valueHash(value, salt).slice(0, 12)}]]`;
}

function collectMatches(
  text: string,
  kind: PiiSweepKind,
  pattern: RegExp,
  engine: string,
): PiiSweepSpan[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => {
    const value = match[0];
    const start = match.index ?? 0;
    return {
      kind,
      start,
      end: start + value.length,
      text: value,
      confidence: 0.95,
      engine,
    };
  });
}

function resolveOverlaps(spans: PiiSweepSpan[]): PiiSweepSpan[] {
  const byLength = [...spans].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: PiiSweepSpan[] = [];
  for (const span of byLength) {
    if (!kept.some((item) => span.start < item.end && item.start < span.end)) {
      kept.push(span);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function createDeterministicPiiSweepEngine(
  name = "pf-cli-contract",
): PiiSweepEngine {
  return {
    name,
    async classify(text) {
      return resolveOverlaps([
        ...collectMatches(text, "date", DATE_PATTERN, name),
        ...collectMatches(text, "account", ACCOUNT_PATTERN, name),
        ...collectMatches(text, "address", ADDRESS_PATTERN, name),
        ...collectMatches(text, "secret", SECRET_PATTERN, name),
      ]);
    },
  };
}

export function assertPfCliConfig(config: PfCliConfig): void {
  if (!config.binaryPath.trim()) {
    throw new Error("pf-cli binaryPath is required");
  }
  if (!config.modelPath.endsWith("privacy-filter-f16.gguf")) {
    throw new Error(
      "privacy-filter f16 model is required; q8 is rejected because it can miss token labels",
    );
  }
}

export function createPfCliEngine(config: PfCliConfig): PiiSweepEngine {
  assertPfCliConfig(config);
  const threshold = config.threshold ?? 0.5;
  return {
    name: "pf-cli",
    async classify(text) {
      const stdout = await runPfCli(
        config.binaryPath,
        ["--classify", config.modelPath, String(threshold)],
        text,
      );
      const parsed = JSON.parse(stdout) as { spans?: PiiSweepSpan[] };
      if (!Array.isArray(parsed.spans)) {
        throw new Error("pf-cli output did not include spans");
      }
      return parsed.spans.map((span) => ({
        ...span,
        engine: "pf-cli",
      }));
    },
  };
}

async function runPfCli(
  binaryPath: string,
  args: readonly string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `pf-cli exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

export async function applyPiiSweep(
  message: CorpusMessage,
  engine: PiiSweepEngine,
  options: { hashSalt: string },
): Promise<PiiSweepResult> {
  const spans = await engine.classify(message.text);
  for (const span of spans) {
    const actual = message.text.slice(span.start, span.end);
    if (actual !== span.text) {
      throw new Error(
        `PII sweep span mismatch for ${message.id}: expected ${JSON.stringify(
          span.text,
        )} at ${span.start}-${span.end}`,
      );
    }
  }
  const replacements = spans.map((span) => ({
    ...span,
    valueHash: valueHash(span.text, options.hashSalt),
    replacement: replacementFor(span.kind, span.text, options.hashSalt),
  }));
  let text = message.text;
  for (const replacement of [...replacements].sort(
    (a, b) => b.start - a.start,
  )) {
    text =
      text.slice(0, replacement.start) +
      replacement.replacement +
      text.slice(replacement.end);
  }
  for (const replacement of replacements) {
    if (text.includes(replacement.text)) {
      throw new Error(
        `PII sweep failed to remove ${replacement.kind} span ${replacement.valueHash}`,
      );
    }
  }
  return {
    message: {
      ...message,
      text,
      scrubState: "rewritten",
    },
    replacements,
  };
}

function spanKey(span: PiiSweepSpan): string {
  return `${span.kind}:${span.start}:${span.end}:${span.text}`;
}

export async function comparePiiSweepEngines(
  messages: readonly CorpusMessage[],
  baseline: PiiSweepEngine,
  candidate: PiiSweepEngine,
): Promise<EngineParityReport> {
  const baselineSpans = (
    await Promise.all(
      messages.map((message) => baseline.classify(message.text)),
    )
  ).flat();
  const candidateSpans = (
    await Promise.all(
      messages.map((message) => candidate.classify(message.text)),
    )
  ).flat();
  const candidateKeys = new Set(candidateSpans.map(spanKey));
  const baselineKeys = new Set(baselineSpans.map(spanKey));
  return {
    messageCount: messages.length,
    baselineEngine: baseline.name,
    candidateEngine: candidate.name,
    baselineSpanCount: baselineSpans.length,
    candidateSpanCount: candidateSpans.length,
    matchedSpanCount: baselineSpans.filter((span) =>
      candidateKeys.has(spanKey(span)),
    ).length,
    missingFromCandidate: baselineSpans.filter(
      (span) => !candidateKeys.has(spanKey(span)),
    ),
    extraInCandidate: candidateSpans.filter(
      (span) => !baselineKeys.has(spanKey(span)),
    ),
  };
}
