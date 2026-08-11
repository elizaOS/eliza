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
import { ElizaError, logger } from "@elizaos/core";
import type { AudioRedactionSpan } from "@elizaos/shared/audio-redaction";
import type { RedactionVerifyResult } from "@elizaos/shared/audio-redaction-verify";
import { resolveStateDir } from "../config/paths.ts";
import type { AudioRedactionMode } from "./audio-redaction.ts";
import { redactAudioBytes } from "./audio-redaction.ts";
import {
  isValidStoredMediaFileName,
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
        typeof (entry as RedactionMemoEntry).fileName === "string" &&
        isValidStoredMediaFileName((entry as RedactionMemoEntry).fileName),
    );
  } catch {
    // error-policy:J3 untrusted-input sanitizing — absent on first run
    // (ENOENT) or hand-corrupted JSON both mean "no memo"; the redaction
    // recomputes and converges on the same content address.
    return [];
  }
}

function writeMemo(key: string, fileName: string): void {
  if (!isValidStoredMediaFileName(fileName)) {
    throw new ElizaError("refusing to memoize an invalid media filename", {
      code: "MEDIA_STORE_FILENAME_INVALID",
      context: { fileName },
    });
  }
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
      { error: err instanceof Error ? err.message : String(err) },
      "[audio-redaction-store] could not write redaction memo",
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
  assertKeyParts(parts);
  const canonicalSpans = parts.spans.map((span) => [span.startMs, span.endMs]);
  const spanHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalSpans))
    .digest("hex")
    .slice(0, 16);
  return `pii-audio:${parts.originalSha}:v${parts.rulesetVersion}:${parts.mode}:${spanHash}`;
}

function assertKeyParts(parts: AudioRedactionKeyParts): void {
  if (!/^[a-f0-9]{64}$/.test(parts.originalSha)) {
    throw new ElizaError("audio redaction original sha is invalid", {
      code: "AUDIO_REDACTION_INPUT_INVALID",
    });
  }
  if (!/^[a-z0-9._-]{1,64}$/i.test(parts.rulesetVersion)) {
    throw new ElizaError("audio redaction ruleset version is invalid", {
      code: "AUDIO_REDACTION_INPUT_INVALID",
    });
  }
  if (parts.mode !== "mute" && parts.mode !== "bleep") {
    throw new ElizaError("audio redaction mode is invalid", {
      code: "AUDIO_REDACTION_INPUT_INVALID",
    });
  }
  if (parts.spans.length === 0) {
    throw new ElizaError("audio redaction requires at least one span", {
      code: "AUDIO_REDACTION_INPUT_INVALID",
    });
  }
  let previousEnd = -1;
  for (const span of parts.spans) {
    if (
      !Number.isFinite(span.startMs) ||
      !Number.isFinite(span.endMs) ||
      span.startMs < 0 ||
      span.endMs <= span.startMs ||
      span.startMs < previousEnd
    ) {
      throw new ElizaError(
        "audio redaction spans must be sorted, non-overlapping, and positive",
        { code: "AUDIO_REDACTION_INPUT_INVALID" },
      );
    }
    previousEnd = span.endMs;
  }
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
 * recomputes via {@link prepareRedactedAudioVariant}, verifies, and publishes
 * via {@link persistVerifiedRedactedAudioVariant}; determinism lands on the
 * same output sha.
 */
export function findRedactedAudioVariant(
  parts: AudioRedactionKeyParts,
): RedactedAudioVariant | null {
  const key = audioRedactionKey(parts);
  const entry = readMemo().find((candidate) => candidate.key === key);
  if (
    !entry ||
    entry.fileName.startsWith(`${parts.originalSha}.`) ||
    !storedMediaFileExists(entry.fileName)
  )
    return null;
  return {
    url: `/api/media/${entry.fileName}`,
    hash: entry.fileName.slice(0, 64),
    fileName: entry.fileName,
    key,
    reused: true,
  };
}

/** Request for {@link prepareRedactedAudioVariant}. */
export interface PrepareRedactedAudioVariantRequest {
  /** The ORIGINAL's stored name (`<sha256>.<ext>`) in the media store. */
  originalFileName: string;
  spans: readonly AudioRedactionSpan[];
  mode: AudioRedactionMode;
  rulesetVersion: string;
}

export interface PreparedRedactedAudioVariant {
  key: string;
  originalSha: string;
  bytes: Buffer;
  mimeType: string;
  lane: "pure-ts-wav" | "ffmpeg";
  inputDurationMs: number;
}

/**
 * Prepare candidate bytes from a stored original without publishing them:
 * read the original and run the duration-preserving redaction op. The caller
 * must verify the candidate and pass it to
 * {@link persistVerifiedRedactedAudioVariant}. Determinism means re-running
 * the identical job yields the identical output sha.
 *
 * The caller wires the returned URL into the artifact record for
 * non-privileged viewers (reference distribution is the permission boundary;
 * the serve path stays capability-addressed). This module never touches
 * records or roles.
 */
export async function prepareRedactedAudioVariant(
  request: PrepareRedactedAudioVariantRequest,
): Promise<PreparedRedactedAudioVariant> {
  if (!isValidStoredMediaFileName(request.originalFileName)) {
    throw new ElizaError("audio redaction original filename is invalid", {
      code: "MEDIA_STORE_FILENAME_INVALID",
      context: { fileName: request.originalFileName },
    });
  }
  const originalSha = request.originalFileName.slice(0, 64);
  const keyParts: AudioRedactionKeyParts = {
    originalSha,
    spans: request.spans,
    mode: request.mode,
    rulesetVersion: request.rulesetVersion,
  };
  const key = audioRedactionKey(keyParts);

  const originalBytes = readStoredMediaBytes(request.originalFileName);
  if (!originalBytes) {
    throw new ElizaError("audio redaction original media is not in the store", {
      code: "AUDIO_REDACTION_ORIGINAL_MISSING",
      context: { fileName: request.originalFileName },
    });
  }
  const ext = request.originalFileName.split(".").pop();
  if (!ext) {
    throw new ElizaError("audio redaction media extension is missing", {
      code: "MEDIA_STORE_FILENAME_INVALID",
    });
  }
  const result = await redactAudioBytes({
    bytes: originalBytes,
    containerExt: ext,
    spans: request.spans,
    mode: request.mode,
  });
  const outputSha = crypto
    .createHash("sha256")
    .update(result.bytes)
    .digest("hex");
  if (outputSha === originalSha) {
    throw new ElizaError(
      "audio redaction produced bytes identical to the original",
      { code: "AUDIO_REDACTION_UNCHANGED" },
    );
  }
  return {
    key,
    originalSha,
    bytes: result.bytes,
    mimeType: mimeForStoredMediaFile(request.originalFileName),
    lane: result.lane,
    inputDurationMs: result.inputDurationMs,
  };
}

export function persistVerifiedRedactedAudioVariant(
  prepared: PreparedRedactedAudioVariant,
  verification: RedactionVerifyResult,
): RedactedAudioVariant {
  if (
    !verification.ok ||
    verification.findings.length === 0 ||
    verification.findings.some(
      (finding) =>
        !finding.ok ||
        !finding.verifierId.trim() ||
        !finding.transcript.trim() ||
        finding.piiFound.length > 0 ||
        finding.sentinelsMissing.length > 0,
    )
  ) {
    throw new ElizaError(
      "audio redaction variant did not pass mandatory re-transcription verification",
      { code: "AUDIO_REDACTION_VERIFY_FAILED" },
    );
  }
  const persisted = persistMediaBytes(prepared.bytes, prepared.mimeType);
  if (persisted.hash === prepared.originalSha) {
    throw new ElizaError(
      "verified audio redaction resolved to the original content address",
      { code: "AUDIO_REDACTION_UNCHANGED" },
    );
  }
  writeMemo(prepared.key, persisted.fileName);
  logger.info(
    {
      fileName: persisted.fileName,
      lane: prepared.lane,
      inputDurationMs: prepared.inputDurationMs,
      key: prepared.key,
      verifierIds: verification.findings.map((finding) => finding.verifierId),
    },
    "[audio-redaction-store] stored verified redacted variant",
  );
  return {
    url: persisted.url,
    hash: persisted.hash,
    fileName: persisted.fileName,
    key: prepared.key,
    reused: false,
  };
}
