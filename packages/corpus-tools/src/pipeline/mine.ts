/**
 * Deterministic PII candidate mining for corpus scrub stage 0. The miner joins
 * core structured detectors with a contact-derived gazetteer and emits
 * source-referenced candidates, frequency summaries, and owner-review CSV rows
 * without assigning replacement pseudonyms.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CompositeEntityRecognizer,
  detectPii,
  type EntitySpan,
  GazetteerEntityRecognizer,
  getDefaultRedactPatterns,
  type PiiMatch,
  RegexEntityRecognizer,
} from "@elizaos/core";
import type { CorpusContact, CorpusMessage } from "../schema.ts";

export interface PiiCandidate {
  msgId: string;
  sourceRef: {
    tableName: "corpus_messages";
    memoryId: string;
    threadId: string;
    platform: CorpusMessage["platform"];
    accountId: string;
    field: "text";
    span: { start: number; end: number };
  };
  kind: string;
  surfaceForm: string;
  valueHash: string;
  context: string;
  confidence: number;
  detector: "structured" | "entity" | "redact-pattern";
}

export interface PiiFrequencyRow {
  kind: string;
  valueHash: string;
  count: number;
  sample: string;
  sampleContext: string;
}

export interface PiiMineArtifacts {
  candidates: PiiCandidate[];
  frequencies: PiiFrequencyRow[];
  reviewCsv: string;
}

export interface MinePiiOptions {
  contacts?: readonly CorpusContact[];
  hashSalt: string;
}

interface RawCandidate {
  start: number;
  end: number;
  kind: string;
  value: string;
  confidence: number;
  detector: PiiCandidate["detector"];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function valueHash(value: string, salt: string): string {
  return sha256(`${salt}\0${value}`);
}

function contextAround(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 40), Math.min(text.length, end + 40));
}

function csvCell(value: string | number): string {
  const text = String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function contactGazetteerEntries(
  messages: readonly CorpusMessage[],
  contacts: readonly CorpusContact[],
): Array<{ kind: string; value: string }> {
  const entries: Array<{ kind: string; value: string }> = [];
  const add = (kind: string, value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 2) entries.push({ kind, value: trimmed });
  };
  for (const contact of contacts) {
    add("person", contact.display);
    for (const email of contact.emails) add("email", email);
    for (const phone of contact.phones) add("phone", phone);
    for (const handle of contact.handles) add("person", handle.handle);
  }
  for (const message of messages) {
    add("person", message.senderDisplay);
    add("email", message.senderId.includes("@") ? message.senderId : undefined);
    for (const recipient of message.recipients) {
      add("person", recipient.display);
      add("email", recipient.address);
    }
  }
  return entries;
}

function redactPatternMatches(text: string): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const rawPattern of getDefaultRedactPatterns()) {
    // `gi`, matching how the production redactor and secret-swap compile the
    // IDENTICAL pattern list (core/src/security/redact.ts parsePattern and
    // secret-swap.ts both default to "gi"). The name-based patterns
    // (password:/token=/authorization: bearer/...) are case-divergent in the
    // wild - compiling them case-sensitively here made this recall-oriented
    // miner strictly less sensitive than the redactor it feeds, silently
    // under-reporting candidates on the stage-0 human-review surface.
    // JS RegExp has no inline (?i), so per-pattern case intent cannot live in
    // the pattern source; a genuinely case-sensitive pattern belongs in the
    // /pattern/flags escape-hatch form core supports. Over-matching here only
    // adds rows to a human-review CSV - the correct failure direction for a
    // miner.
    const pattern = new RegExp(rawPattern, "gi");
    for (const match of text.matchAll(pattern)) {
      const value = match[match.length - 1] || match[0];
      if (!value) continue;
      const whole = match[0];
      const start = (match.index ?? 0) + whole.indexOf(value);
      candidates.push({
        start,
        end: start + value.length,
        kind: "redact-pattern",
        value,
        confidence: 0.95,
        detector: "redact-pattern",
      });
    }
  }
  return candidates;
}

function fromPiiMatch(match: PiiMatch): RawCandidate {
  return {
    start: match.start,
    end: match.end,
    kind: match.kind,
    value: match.value,
    confidence: 1,
    detector: "structured",
  };
}

function fromEntitySpan(span: EntitySpan): RawCandidate | undefined {
  if (span.start === undefined || span.end === undefined) return undefined;
  return {
    start: span.start,
    end: span.end,
    kind: span.kind,
    value: span.value,
    confidence: span.score ?? 0.85,
    detector: "entity",
  };
}

function resolveCandidateOverlaps(candidates: RawCandidate[]): RawCandidate[] {
  const sorted = [...candidates].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: RawCandidate[] = [];
  for (const candidate of sorted) {
    if (
      kept.some(
        (other) => candidate.start < other.end && other.start < candidate.end,
      )
    ) {
      continue;
    }
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export async function minePiiCandidates(
  messages: readonly CorpusMessage[],
  options: MinePiiOptions,
): Promise<PiiMineArtifacts> {
  const recognizer = new CompositeEntityRecognizer([
    new GazetteerEntityRecognizer(
      contactGazetteerEntries(messages, options.contacts ?? []),
      { name: "corpus-contact-gazetteer" },
    ),
    new RegexEntityRecognizer({ address: true, email: true, phone: true }),
  ]);
  const candidates: PiiCandidate[] = [];

  for (const message of messages) {
    const structured = detectPii(message.text).map(fromPiiMatch);
    const entitySpans = (await recognizer.recognize(message.text))
      .map(fromEntitySpan)
      .filter((span): span is RawCandidate => span !== undefined);
    const rawCandidates = resolveCandidateOverlaps([
      ...structured,
      ...entitySpans,
      ...redactPatternMatches(message.text),
    ]);
    for (const candidate of rawCandidates) {
      candidates.push({
        msgId: message.id,
        sourceRef: {
          tableName: "corpus_messages",
          memoryId: message.id,
          threadId: message.threadId,
          platform: message.platform,
          accountId: message.accountId,
          field: "text",
          span: { start: candidate.start, end: candidate.end },
        },
        kind: candidate.kind,
        surfaceForm: candidate.value,
        valueHash: valueHash(candidate.value, options.hashSalt),
        context: contextAround(message.text, candidate.start, candidate.end),
        confidence: candidate.confidence,
        detector: candidate.detector,
      });
    }
  }

  const byValue = new Map<string, PiiFrequencyRow>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\0${candidate.valueHash}`;
    const existing = byValue.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byValue.set(key, {
      kind: candidate.kind,
      valueHash: candidate.valueHash,
      count: 1,
      sample: candidate.surfaceForm,
      sampleContext: candidate.context,
    });
  }
  const frequencies = [...byValue.values()].sort(
    (a, b) => b.count - a.count || a.kind.localeCompare(b.kind),
  );
  const reviewCsv = [
    ["kind", "valueHash", "count", "sample", "sampleContext"]
      .map(csvCell)
      .join(","),
    ...frequencies.map((row) =>
      [row.kind, row.valueHash, row.count, row.sample, row.sampleContext]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");

  return { candidates, frequencies, reviewCsv: `${reviewCsv}\n` };
}

export async function writeMineArtifacts(
  stateDir: string,
  artifacts: PiiMineArtifacts,
): Promise<{
  candidatesPath: string;
  frequencyPath: string;
  reviewCsvPath: string;
}> {
  await fs.mkdir(stateDir, { recursive: true });
  const candidatesPath = path.join(stateDir, "candidates.jsonl");
  const frequencyPath = path.join(stateDir, "candidate-frequency.json");
  const reviewCsvPath = path.join(stateDir, "candidate-review.csv");
  await fs.writeFile(
    candidatesPath,
    `${artifacts.candidates.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`,
  );
  await fs.writeFile(
    frequencyPath,
    `${JSON.stringify(artifacts.frequencies, null, 2)}\n`,
  );
  await fs.writeFile(reviewCsvPath, artifacts.reviewCsv);
  return { candidatesPath, frequencyPath, reviewCsvPath };
}
