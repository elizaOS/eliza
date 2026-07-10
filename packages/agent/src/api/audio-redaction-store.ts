/**
 * Audio PII redaction — content-addressed variant storage (#14807, #8876-clean).
 *
 * The redacted variant is just ANOTHER OBJECT in the one existing
 * content-addressed media store (`media-store.ts`): redacted bytes go through
 * `persistMediaBytes` and come back as `${STATE_DIR}/media/<sha256'>.<ext>`
 * served at `/api/media/<sha256'>.<ext>`. There is NO second store, no files
 * table, no refcount engine, and no `fileId` on `Media` — reference
 * distribution (original URL for OWNER/ADMIN, redacted URL for everyone else)
 * lives in the transcript/document record, and `gcUnreferencedMedia` keeps
 * each variant alive exactly while referenced, like any other media object.
 *
 * Idempotency is content-addressed end to end: the redaction op is
 * deterministic (pure-TS WAV lane bit-exact; ffmpeg lane `-bitexact`), so
 * `same original sha + same spans + same mode + same ruleset version ⇒ same
 * output sha`. A small capped memo (`audio-redactions.json` in the media dir,
 * the `background-pins.json` precedent) maps the derived job key
 * `pii-audio:<sha>:v<ruleset>:<mode>:<spanHash>` to the variant's stored name
 * so re-runs are cheap lookups — the memo is a CACHE, not a source of truth:
 * if it is lost or the variant was GC'd, re-running the redaction converges
 * on the identical output sha.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import type { AudioRedactionSpan } from "@elizaos/shared/audio-redaction";
import { resolveStateDir } from "../config/paths.ts";
import type { AudioRedactionMode } from "./audio-redaction.ts";
import { redactAudioBytes } from "./audio-redaction.ts";
import {
  mimeForStoredMediaFile,
  persistMediaBytes,
  readStoredMediaBytes,
  storedMediaFileExists,
} from "./media-store.ts";

/** Memo file next to the media objects (sibling of background-pins.json). */
const REDACTION_MEMO_FILE = "audio-redactions.json";
/** Cap so replaced/abandoned redaction keys age out with their variants. */
const MAX_MEMO_ENTRIES = 256;

interface RedactionMemoEntry {
  key: string;
  fileName: string;
}

function memoPath(): string {
  return path.join(resolveStateDir(), "media", REDACTION_MEMO_FILE);
}

function readMemo(): RedactionMemoEntry[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(memoPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RedactionMemoEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RedactionMemoEntry).key === "string" &&
        typeof (entry as RedactionMemoEntry).fileName === "string",
    );
  } catch {
    // error-policy:J3 untrusted-input sanitizing — absent on first run
    // (ENOENT) or hand-corrupted JSON both mean "no memo"; the redaction
    // recomputes and converges on the same content address.
    return [];
  }
}

function writeMemo(key: string, fileName: string): void {
  try {
    const entries = readMemo().filter((entry) => entry.key !== key);
    entries.push({ key, fileName });
    fs.mkdirSync(path.dirname(memoPath()), { recursive: true });
    fs.writeFileSync(
      memoPath(),
      JSON.stringify(entries.slice(-MAX_MEMO_ENTRIES)),
    );
  } catch (err) {
    // error-policy:J6 best-effort — the memo is a lookup cache; a failed
    // write only costs a recompute that lands on the identical output sha.
    logger.warn(
      `[audio-redaction-store] could not write redaction memo: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Inputs that content-address one redaction job. */
export interface AudioRedactionKeyParts {
  /** sha256 of the ORIGINAL bytes (the store hash / capability). */
  originalSha: string;
  /** Merged, non-overlapping windows (labels do not affect the bytes). */
  spans: readonly AudioRedactionSpan[];
  mode: AudioRedactionMode;
  /** Active PII ruleset version — a bump re-redacts deterministically. */
  rulesetVersion: string;
}

/**
 * Derive the content-addressed job key — the audio analog of the text lane's
 * `pii:<sha256>:v<ruleset>` done-marker (#14808), extended with the mode and
 * a hash of the canonical span windows.
 */
export function audioRedactionKey(parts: AudioRedactionKeyParts): string {
  const canonicalSpans = parts.spans.map((span) => [span.startMs, span.endMs]);
  const spanHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalSpans))
    .digest("hex")
    .slice(0, 16);
  return `pii-audio:${parts.originalSha}:v${parts.rulesetVersion}:${parts.mode}:${spanHash}`;
}

/** A stored redacted variant handle. */
export interface RedactedAudioVariant {
  /** Served URL of the REDACTED bytes (`/api/media/<sha256'>.<ext>`). */
  url: string;
  /** sha256 of the redacted bytes — the variant's own content address. */
  hash: string;
  fileName: string;
  /** The job key this variant answers. */
  key: string;
  /** True when the variant came from the memo (no recompute). */
  reused: boolean;
}

/**
 * Look up an existing redacted variant for the job key. Returns null when the
 * memo has no entry or the variant bytes were evicted/GC'd — the caller then
 * recomputes via {@link persistRedactedAudioVariant} and, by determinism,
 * lands on the same output sha.
 */
export function findRedactedAudioVariant(
  parts: AudioRedactionKeyParts,
): RedactedAudioVariant | null {
  const key = audioRedactionKey(parts);
  const entry = readMemo().find((candidate) => candidate.key === key);
  if (!entry || !storedMediaFileExists(entry.fileName)) return null;
  return {
    url: `/api/media/${entry.fileName}`,
    hash: entry.fileName.slice(0, 64),
    fileName: entry.fileName,
    key,
    reused: true,
  };
}

/** Request for {@link persistRedactedAudioVariant}. */
export interface PersistRedactedAudioVariantRequest {
  /** The ORIGINAL's stored name (`<sha256>.<ext>`) in the media store. */
  originalFileName: string;
  spans: readonly AudioRedactionSpan[];
  mode: AudioRedactionMode;
  rulesetVersion: string;
}

/**
 * Produce (or reuse) the redacted variant of a stored original: read the
 * original's bytes from the store, run the duration-preserving redaction op,
 * and persist the output as a SECOND content-addressed object in the SAME
 * store. Deterministic ⇒ idempotent: re-running the identical job yields the
 * identical output sha (and the memo makes the re-run a cheap lookup).
 *
 * The caller wires the returned URL into the artifact record for
 * non-privileged viewers (reference distribution is the permission boundary;
 * the serve path stays capability-addressed). This module never touches
 * records or roles.
 */
export async function persistRedactedAudioVariant(
  request: PersistRedactedAudioVariantRequest,
): Promise<RedactedAudioVariant> {
  const originalSha = request.originalFileName.slice(0, 64);
  const keyParts: AudioRedactionKeyParts = {
    originalSha,
    spans: request.spans,
    mode: request.mode,
    rulesetVersion: request.rulesetVersion,
  };
  const existing = findRedactedAudioVariant(keyParts);
  if (existing) {
    logger.debug(
      `[audio-redaction-store] reusing redacted variant ${existing.fileName} for ${existing.key}`,
    );
    return existing;
  }

  const originalBytes = readStoredMediaBytes(request.originalFileName);
  if (!originalBytes) {
    throw new Error(
      `original media ${request.originalFileName} is not in the store`,
    );
  }
  const ext = request.originalFileName.split(".").pop() ?? "bin";
  const result = await redactAudioBytes({
    bytes: originalBytes,
    containerExt: ext,
    spans: request.spans,
    mode: request.mode,
  });
  const persisted = persistMediaBytes(
    result.bytes,
    mimeForStoredMediaFile(request.originalFileName),
  );
  const key = audioRedactionKey(keyParts);
  writeMemo(key, persisted.fileName);
  logger.info(
    `[audio-redaction-store] stored redacted variant ${persisted.fileName} ` +
      `(lane=${result.lane}, ${result.inputDurationMs.toFixed(1)}ms preserved) for ${key}`,
  );
  return {
    url: persisted.url,
    hash: persisted.hash,
    fileName: persisted.fileName,
    key,
    reused: false,
  };
}
