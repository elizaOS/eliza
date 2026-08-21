/**
 * Curated repository notes for completed coding tasks.
 *
 * The orchestrator writes only bounded, provenance-bearing lessons after the
 * durable task has reached verified `done` with GitHub ground truth. The file is
 * plain Markdown so operators can review diffs, while this service owns the
 * isolation, redaction, dedupe, and atomic-write rules that keep it safe to use
 * as future coding context.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  OrchestratorTaskDocument,
  OrchestratorTaskMessage,
} from "./orchestrator-task-types.js";

export const CURATED_CODING_MEMORY_FILENAME = "NOTES.eliza.md";

const MAX_NOTE_TEXT_CHARS = 280;
const MAX_NOTE_COUNT_DEFAULT = 40;
const MAX_FILE_BYTES_DEFAULT = 24_000;
const MAX_INJECTED_NOTES_DEFAULT = 6;
const MAX_INJECTED_TOKENS_DEFAULT = 500;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 10_000;
const MIN_TOKEN_LENGTH = 3;

export type CodingMemorySource =
  | "verified_completion"
  | "test_failure_fix"
  | "reviewer_finding"
  | "user_decision";

export interface CuratedCodingMemoryNote {
  id: string;
  text: string;
  source: CodingMemorySource;
  provenance: string[];
  timestamp: string;
  confidence: number;
  repoKey: string;
  tenantHash: string;
  taskId: string;
}

export interface CuratedCodingMemoryPolicy {
  enabled: boolean;
  injectEnabled: boolean;
  maxNotes: number;
  maxFileBytes: number;
  maxInjectedNotes: number;
  maxInjectedTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function settingEnabled(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = runtime.getSetting?.(key);
  if (value === "1" || value === "true" || value === true) return true;
  if (value === "0" || value === "false" || value === false) return false;
  return defaultValue;
}

function numericSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultValue: number,
): number {
  const raw = runtime.getSetting?.(key);
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function curatedCodingMemoryPolicy(
  runtime: IAgentRuntime,
): CuratedCodingMemoryPolicy {
  return {
    enabled: settingEnabled(runtime, "ELIZA_CURATED_CODING_MEMORY", true),
    injectEnabled: settingEnabled(
      runtime,
      "ELIZA_CURATED_CODING_MEMORY_INJECT",
      true,
    ),
    maxNotes: numericSetting(
      runtime,
      "ELIZA_CURATED_CODING_MEMORY_MAX_NOTES",
      MAX_NOTE_COUNT_DEFAULT,
    ),
    maxFileBytes: numericSetting(
      runtime,
      "ELIZA_CURATED_CODING_MEMORY_MAX_FILE_BYTES",
      MAX_FILE_BYTES_DEFAULT,
    ),
    maxInjectedNotes: numericSetting(
      runtime,
      "ELIZA_CURATED_CODING_MEMORY_MAX_INJECTED",
      MAX_INJECTED_NOTES_DEFAULT,
    ),
    maxInjectedTokens: numericSetting(
      runtime,
      "ELIZA_CURATED_CODING_MEMORY_TOKEN_BUDGET",
      MAX_INJECTED_TOKENS_DEFAULT,
    ),
  };
}

function tenantHash(runtime: IAgentRuntime): string {
  const raw =
    runtime.agentId ??
    runtime.character?.id ??
    runtime.character?.name ??
    "default-agent";
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
}

function repoKeyFor(doc: OrchestratorTaskDocument, workdir: string): string {
  const verdict = readGroundTruthVerdict(doc.task.metadata);
  return (
    verdict?.pr.repo ??
    doc.task.boundRepo ??
    doc.sessions.find((session) => session.workdir === workdir)?.repo ??
    resolve(workdir)
  );
}

function latestWorkdir(doc: OrchestratorTaskDocument): string | undefined {
  return (
    doc.task.boundWorkdir ??
    [...doc.sessions]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .find((session) => session.workdir)?.workdir
  );
}

function memoryRoot(runtime: IAgentRuntime): string {
  const configured = runtime.getSetting?.("ELIZA_CURATED_CODING_MEMORY_DIR");
  if (typeof configured === "string" && configured.trim()) {
    return resolve(configured.trim());
  }
  return join(homedir(), ".eliza", "agent-memory");
}

export function canonicalRepositoryKey(input: string): string | undefined {
  const value = input.trim();
  const url =
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      value,
    );
  if (url?.[1] && url[2]) return `${url[1]}/${url[2]}`.toLowerCase();
  const compact = /^([\w.-]+)\/([\w.-]+)$/.exec(value);
  if (compact?.[1] && compact[2]) {
    return `${compact[1]}/${compact[2]}`.toLowerCase();
  }
  return undefined;
}

function repoDirectory(repoKey: string): string {
  const canonical =
    canonicalRepositoryKey(repoKey) ?? repoKey.trim().toLowerCase();
  const readable = canonical.replace(/[^a-z0-9._-]+/g, "__").slice(0, 80);
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return `${readable || "repo"}--${digest}`;
}

export function curatedCodingMemoryPath(
  runtime: IAgentRuntime,
  repoKey: string,
): string {
  return join(
    memoryRoot(runtime),
    tenantHash(runtime),
    repoDirectory(repoKey),
    CURATED_CODING_MEMORY_FILENAME,
  );
}

interface VerifiedGroundTruthProvenance {
  status: "verified";
  pr: {
    exists: true;
    url?: string;
    repo?: string;
    headSha?: string;
  };
}

function readGroundTruthVerdict(
  metadata: Record<string, unknown> | undefined,
): VerifiedGroundTruthProvenance | undefined {
  const raw = metadata?.groundTruthVerdict;
  if (
    !isRecord(raw) ||
    raw.status !== "verified" ||
    !isRecord(raw.pr) ||
    raw.pr.exists !== true
  ) {
    return undefined;
  }
  return {
    status: "verified",
    pr: {
      exists: true,
      ...(typeof raw.pr.url === "string" ? { url: raw.pr.url } : {}),
      ...(typeof raw.pr.repo === "string" ? { repo: raw.pr.repo } : {}),
      ...(typeof raw.pr.headSha === "string"
        ? { headSha: raw.pr.headSha }
        : {}),
    },
  };
}

function provenanceFor(doc: OrchestratorTaskDocument): string[] {
  const verdict = readGroundTruthVerdict(doc.task.metadata);
  const values = [
    `task:${doc.task.id}`,
    verdict?.pr.url,
    verdict?.pr.headSha ? `sha:${verdict.pr.headSha}` : undefined,
  ];
  return values.filter((value): value is string => Boolean(value));
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*["']?[^"'\s,;]+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\+?\d[\d .()-]{8,}\d)\b/g,
];

function redactPrivateKeys(input: string): string {
  const begin = "-----BEGIN ";
  const end = "-----END ";
  const keySuffix = "PRIVATE KEY-----";
  const fragments: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const blockStart = input.indexOf(begin, cursor);
    if (blockStart < 0) break;
    const headerEnd = input.indexOf(keySuffix, blockStart + begin.length);
    if (headerEnd < 0) break;
    const blockFooter = input.indexOf(end, headerEnd + keySuffix.length);
    if (blockFooter < 0) break;
    const footerEnd = input.indexOf(keySuffix, blockFooter + end.length);
    if (footerEnd < 0) break;
    fragments.push(input.slice(cursor, blockStart), "[REDACTED]");
    cursor = footerEnd + keySuffix.length;
  }
  fragments.push(input.slice(cursor));
  return fragments.join("");
}

export function redactCodingMemoryText(input: string): string {
  let text = redactPrivateKeys(input);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text.replace(/\s+/g, " ").trim();
}

function boundedNoteText(input: string): string {
  const redacted = redactCodingMemoryText(input);
  if (redacted.length <= MAX_NOTE_TEXT_CHARS) return redacted;
  return `${redacted.slice(0, MAX_NOTE_TEXT_CHARS - 1).trimEnd()}…`;
}

function normalizeNoteKey(text: string): string {
  return redactCodingMemoryText(text)
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    normalizeNoteKey(text)
      .split(" ")
      .filter((token) => token.length >= MIN_TOKEN_LENGTH),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function confidenceFor(source: CodingMemorySource): number {
  switch (source) {
    case "reviewer_finding":
    case "user_decision":
      return 0.95;
    case "test_failure_fix":
      return 0.9;
    case "verified_completion":
      return 0.8;
  }
}

const CANDIDATE_PATTERNS: Array<{
  source: CodingMemorySource;
  pattern: RegExp;
}> = [
  {
    source: "user_decision",
    pattern: /\b(?:decision|user decision|explicit decision)\s*:\s*(.+)$/i,
  },
  {
    source: "reviewer_finding",
    pattern: /\b(?:reviewer finding|review finding|review note)\s*:\s*(.+)$/i,
  },
  {
    source: "test_failure_fix",
    pattern:
      /\b(?:test failure\/fix|test failure fix|failing test fixed|test fix)\s*:\s*(.+)$/i,
  },
  {
    source: "verified_completion",
    pattern: /\b(?:lesson|repo lesson|durable lesson)\s*:\s*(.+)$/i,
  },
];

function extractCandidateText(message: OrchestratorTaskMessage): Array<{
  source: CodingMemorySource;
  text: string;
}> {
  // stderr/system streams are commonly raw tool output. Never treat them as
  // memory candidates, even if a command happens to print a matching prefix.
  if (message.direction === "stderr" || message.senderKind === "system") {
    return [];
  }
  const out: Array<{ source: CodingMemorySource; text: string }> = [];
  for (const line of message.content.split(/\r?\n/)) {
    for (const candidate of CANDIDATE_PATTERNS) {
      // A worker cannot declare a user decision or reviewer finding on
      // someone else's behalf. Reviewer findings must arrive through a user or
      // orchestrator-authored message, never the worker's own completion prose.
      if (
        (candidate.source === "user_decision" &&
          message.senderKind !== "user") ||
        (candidate.source === "reviewer_finding" &&
          message.senderKind !== "user" &&
          message.senderKind !== "orchestrator")
      ) {
        continue;
      }
      const match = candidate.pattern.exec(line);
      if (match?.[1]) {
        out.push({
          source: candidate.source,
          text: boundedNoteText(match[1]),
        });
      }
    }
  }
  return out;
}

export function harvestCodingMemoryCandidates(
  doc: OrchestratorTaskDocument,
  runtime: IAgentRuntime,
): CuratedCodingMemoryNote[] {
  if (doc.task.status !== "done") return [];
  const verdict = readGroundTruthVerdict(doc.task.metadata);
  if (
    verdict?.status !== "verified" ||
    verdict.pr.exists !== true ||
    !verdict.pr.repo ||
    !verdict.pr.url ||
    !verdict.pr.headSha
  ) {
    return [];
  }
  const workdir = latestWorkdir(doc);
  if (!workdir) return [];
  const timestamp = new Date().toISOString();
  const repoKey = canonicalRepositoryKey(repoKeyFor(doc, workdir));
  if (!repoKey) return [];
  const provenance = provenanceFor(doc);
  const tenant = tenantHash(runtime);
  const finalWorkerMessageId = [...doc.messages]
    .filter(
      (message) =>
        message.senderKind === "sub_agent" && message.direction === "stdout",
    )
    .sort((a, b) => b.timestamp - a.timestamp)[0]?.id;
  const candidates = doc.messages.flatMap((message) =>
    extractCandidateText(message).filter((candidate) => {
      const workerCompletionOnly =
        message.senderKind === "sub_agent" &&
        (candidate.source === "verified_completion" ||
          candidate.source === "test_failure_fix");
      return !workerCompletionOnly || message.id === finalWorkerMessageId;
    }),
  );
  return candidates
    .filter((candidate) => candidate.text.length > 0)
    .map((candidate) => ({
      id: randomUUID(),
      text: candidate.text,
      source: candidate.source,
      provenance,
      timestamp,
      confidence: confidenceFor(candidate.source),
      repoKey,
      tenantHash: tenant,
      taskId: doc.task.id,
    }));
}

function parseNotes(markdown: string): CuratedCodingMemoryNote[] {
  const notes: CuratedCodingMemoryNote[] = [];
  for (const block of markdown.split(/\n(?=### note:)/)) {
    if (!block.startsWith("### note:")) continue;
    const id = /^### note:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const text = /^- text:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const source = /^- source:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const timestamp = /^- timestamp:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const confidenceRaw = /^- confidence:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const repoKey = /^- repo:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const tenant = /^- tenant:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const taskId = /^- task:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const provenanceRaw = /^- provenance:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (
      !id ||
      !text ||
      !source ||
      !timestamp ||
      !repoKey ||
      !tenant ||
      !taskId
    ) {
      continue;
    }
    notes.push({
      id,
      text,
      source: source as CodingMemorySource,
      timestamp,
      confidence: Number(confidenceRaw ?? "0"),
      repoKey,
      tenantHash: tenant,
      taskId,
      provenance: provenanceRaw
        ? provenanceRaw.split(",").map((part) => part.trim())
        : [],
    });
  }
  return notes;
}

function renderNotes(notes: readonly CuratedCodingMemoryNote[]): string {
  const lines = [
    "# Curated elizaOS Coding Notes",
    "",
    "Reviewable repo-specific lessons harvested only after verified coding-task completion. Do not paste transcripts, raw tool output, secrets, credentials, or personal data here.",
    "",
  ];
  for (const note of notes) {
    lines.push(
      `### note: ${note.id}`,
      `- text: ${note.text}`,
      `- source: ${note.source}`,
      `- provenance: ${note.provenance.join(", ")}`,
      `- timestamp: ${note.timestamp}`,
      `- confidence: ${note.confidence.toFixed(2)}`,
      `- repo: ${note.repoKey}`,
      `- tenant: ${note.tenantHash}`,
      `- task: ${note.taskId}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function mergeNotes(
  existing: readonly CuratedCodingMemoryNote[],
  incoming: readonly CuratedCodingMemoryNote[],
  policy: CuratedCodingMemoryPolicy,
): CuratedCodingMemoryNote[] {
  const merged = [...existing];
  for (const note of incoming) {
    const noteTokens = tokens(note.text);
    const duplicate = merged.find(
      (candidate) =>
        candidate.repoKey === note.repoKey &&
        candidate.tenantHash === note.tenantHash &&
        (normalizeNoteKey(candidate.text) === normalizeNoteKey(note.text) ||
          jaccard(tokens(candidate.text), noteTokens) >= 0.72),
    );
    if (duplicate) {
      duplicate.provenance = [
        ...new Set([...duplicate.provenance, ...note.provenance]),
      ];
      duplicate.confidence = Math.max(duplicate.confidence, note.confidence);
      duplicate.timestamp =
        duplicate.timestamp > note.timestamp
          ? duplicate.timestamp
          : note.timestamp;
      continue;
    }
    merged.push(note);
  }
  return merged
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-policy.maxNotes)
    .reverse();
}

function enforceByteBound(
  notes: CuratedCodingMemoryNote[],
  policy: CuratedCodingMemoryPolicy,
): CuratedCodingMemoryNote[] {
  let bounded = [...notes];
  while (
    bounded.length > 0 &&
    Buffer.byteLength(renderNotes(bounded), "utf8") > policy.maxFileBytes
  ) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}

async function readExistingNotes(
  path: string,
): Promise<CuratedCodingMemoryNote[]> {
  try {
    return parseNotes(await readFile(path, "utf8"));
  } catch (error) {
    // error-policy:J3 absent notes file means there is no prior curated memory.
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function removeLockFileIfTokenMatches(
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    const current = await readFile(lockPath, "utf8");
    if (current === token) await rm(lockPath, { force: true });
  } catch (error) {
    // error-policy:J6 lock cleanup is best-effort; ENOENT means another waiter
    // already reclaimed it after a stale-owner timeout.
    if (!isRecord(error) || error.code !== "ENOENT") return;
  }
}

function lockOwnerIsAlive(token: string): boolean {
  try {
    const owner = JSON.parse(token) as {
      pid?: unknown;
      hostname?: unknown;
    };
    // Never reap another host's lock. A shared filesystem cannot safely prove
    // that remote process dead without a distributed lease service.
    if (owner.hostname !== hostname()) return true;
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid)) {
      return true;
    }
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return !(isRecord(error) && error.code === "ESRCH");
    }
  } catch {
    // A newly-created lock can be observed before its token write completes.
    // Unknown/legacy owners fail closed and are never reaped.
    return true;
  }
}

async function withFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let token = "";
  while (!handle) {
    let pending: Awaited<ReturnType<typeof open>> | undefined;
    try {
      pending = await open(lockPath, "wx");
      token = JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: Date.now(),
        id: randomUUID(),
      });
      await pending.writeFile(token, "utf8");
      handle = pending;
    } catch (error) {
      if (pending) {
        // error-policy:J6 best-effort teardown of a partial lock acquire.
        await pending.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      }
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "EEXIST" || Date.now() > deadline) throw error;
      try {
        const lockToken = await readFile(lockPath, "utf8");
        const info = await stat(lockPath);
        if (
          Date.now() - info.mtimeMs >= LOCK_STALE_MS &&
          !lockOwnerIsAlive(lockToken)
        ) {
          await removeLockFileIfTokenMatches(lockPath, lockToken);
        }
      } catch (staleError) {
        // error-policy:J3 stale-lock stat: ENOENT means the lock disappeared
        // between attempts; other failures should stop the write.
        if (!isRecord(staleError) || staleError.code !== "ENOENT") {
          throw staleError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await removeLockFileIfTokenMatches(lockPath, token);
  }
}

export class CuratedCodingMemoryService {
  private readonly writeQueue = new Map<string, Promise<void>>();

  constructor(private readonly runtime: IAgentRuntime) {}

  async harvestVerifiedTask(doc: OrchestratorTaskDocument): Promise<void> {
    const policy = curatedCodingMemoryPolicy(this.runtime);
    if (!policy.enabled) return;
    const workdir = latestWorkdir(doc);
    if (!workdir) return;
    const incoming = harvestCodingMemoryCandidates(doc, this.runtime);
    if (incoming.length === 0) return;
    const repoKey = incoming[0]?.repoKey;
    if (!repoKey) return;
    // Notes live in agent-owned state, never inside the verified Git worktree.
    // Writing after the residuals gate therefore cannot dirty completed code.
    const path = curatedCodingMemoryPath(this.runtime, repoKey);
    await mkdir(dirname(path), { recursive: true });
    await this.enqueueWrite(path, async () => {
      await withFileLock(path, async () => {
        const existing = await readExistingNotes(path);
        const merged = enforceByteBound(
          mergeNotes(existing, incoming, policy),
          policy,
        );
        const proposed = renderNotes(merged);
        // Land the review artifact atomically before the durable notes file.
        // Operators can diff this sidecar and policy can disable the entire
        // path; no partial proposal or final file is ever observable.
        const proposalPath = `${path}.proposed`;
        const proposalTemp = `${proposalPath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(proposalTemp, proposed, "utf8");
        await rename(proposalTemp, proposalPath);
        const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, proposed, "utf8");
        await rename(tempPath, path);
      });
    });
  }

  async retrieveRelevant(input: {
    text: string;
    /** Expected repository identity from the bound task/session. When present,
     * notes from any other repo are rejected even if a file was copied or a
     * caller supplied the wrong workspace path. */
    repoKey?: string;
  }): Promise<CuratedCodingMemoryNote[]> {
    const policy = curatedCodingMemoryPolicy(this.runtime);
    if (!policy.enabled || !policy.injectEnabled) return [];
    const expectedRepo = input.repoKey
      ? canonicalRepositoryKey(input.repoKey)
      : undefined;
    // Repo identity is mandatory. Never guess from process.cwd() or accept a
    // caller-supplied workdir as an isolation boundary.
    if (!expectedRepo) return [];
    const path = curatedCodingMemoryPath(this.runtime, expectedRepo);
    const queryTokens = tokens(input.text);
    const tenant = tenantHash(this.runtime);
    const notes = (await readExistingNotes(path))
      .filter(
        (note) =>
          note.tenantHash === tenant &&
          canonicalRepositoryKey(note.repoKey) === expectedRepo,
      )
      // Treat disk as untrusted input. Notes may be manually edited, copied, or
      // predate newer redaction rules, so sanitize again at the prompt boundary.
      .map((note) => ({
        ...note,
        text: boundedNoteText(note.text),
      }))
      .filter((note) => note.text.length > 0);
    const ranked = notes
      .map((note) => ({
        note,
        score: jaccard(tokens(note.text), queryTokens),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.note.confidence - a.note.confidence ||
          b.note.timestamp.localeCompare(a.note.timestamp),
      );
    const selected: CuratedCodingMemoryNote[] = [];
    let tokenEstimate = 0;
    for (const { note } of ranked) {
      if (selected.length >= policy.maxInjectedNotes) break;
      // A conservative character-based estimate avoids pulling in a tokenizer
      // dependency while still enforcing an explicit prompt token budget.
      const noteTokens = Math.ceil(
        (note.text.length + note.provenance.join(", ").length + 32) / 3,
      );
      if (tokenEstimate + noteTokens > policy.maxInjectedTokens) continue;
      selected.push(note);
      tokenEstimate += noteTokens;
    }
    return selected;
  }

  private enqueueWrite(
    path: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const prior = this.writeQueue.get(path) ?? Promise.resolve();
    const run = prior.then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueue.set(path, tail);
    void tail.then(() => {
      if (this.writeQueue.get(path) === tail) this.writeQueue.delete(path);
    });
    return run;
  }
}

const servicesByRuntime = new WeakMap<
  IAgentRuntime,
  CuratedCodingMemoryService
>();

export function getCuratedCodingMemoryService(
  runtime: IAgentRuntime,
): CuratedCodingMemoryService {
  const existing = servicesByRuntime.get(runtime);
  if (existing) return existing;
  const created = new CuratedCodingMemoryService(runtime);
  servicesByRuntime.set(runtime, created);
  return created;
}

export function renderInjectedCodingNotes(
  notes: readonly CuratedCodingMemoryNote[],
): string {
  if (notes.length === 0) return "";
  return [
    "curated_coding_memory:",
    ...notes.map(
      (note) =>
        `  - ${note.text} (confidence ${note.confidence.toFixed(2)}; ${note.provenance.join(", ")})`,
    ),
  ].join("\n");
}
