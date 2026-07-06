/**
 * Canonical personal-corpus interchange contract for collectors, scrub stages,
 * and mock loaders. The schema is intentionally collector-neutral: source
 * platforms keep their native provenance in `platform`/`accountId`, while
 * downstream tests consume validated messages, contacts, threads, and shard
 * manifests without learning Gmail, Telegram, Discord, iMessage, Signal, or X
 * export formats.
 */
import { z } from "zod";

export const CORPUS_CUTOFF_ISO = "2024-07-05";
export const CORPUS_ANCHOR_ISO = "2026-07-05T00:00:00.000Z";
export const CORPUS_CUTOFF_MS = Date.parse(
  `${CORPUS_CUTOFF_ISO}T00:00:00.000Z`,
);
export const CORPUS_ANCHOR_MS = Date.parse(CORPUS_ANCHOR_ISO);

export const corpusPlatforms = [
  "gmail",
  "telegram",
  "discord",
  "imessage",
  "signal",
  "x",
] as const;

export const scrubStates = [
  "raw",
  "mined",
  "swapped",
  "rewritten",
  "verified",
] as const;

export const directions = ["in", "out"] as const;

const nonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = z.string().trim().min(1).optional();

export const corpusRecipientSchema = z.object({
  id: nonEmptyString,
  display: optionalNonEmptyString,
  address: optionalNonEmptyString,
});

export const corpusAttachmentSchema = z.object({
  filename: nonEmptyString,
  mimeType: nonEmptyString,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
});

export const corpusMessageSchema = z.object({
  id: nonEmptyString,
  platform: z.enum(corpusPlatforms),
  accountId: nonEmptyString,
  threadId: nonEmptyString,
  ts: z.number().int().min(CORPUS_CUTOFF_MS),
  direction: z.enum(directions),
  senderId: nonEmptyString,
  senderDisplay: nonEmptyString,
  recipients: z.array(corpusRecipientSchema),
  subject: optionalNonEmptyString,
  text: nonEmptyString,
  snippet: optionalNonEmptyString,
  labels: z.array(nonEmptyString).default([]),
  attachments: z.array(corpusAttachmentSchema).default([]),
  replyToId: optionalNonEmptyString,
  scrubState: z.enum(scrubStates),
});

export const corpusContactSchema = z.object({
  id: nonEmptyString,
  display: nonEmptyString,
  handles: z
    .array(
      z.object({
        platform: z.enum(corpusPlatforms),
        accountId: nonEmptyString,
        handle: nonEmptyString,
      }),
    )
    .default([]),
  emails: z.array(z.string().email()).default([]),
  phones: z.array(nonEmptyString).default([]),
  source: z.enum(["collector", "gazetteer", "manual"]).default("collector"),
});

export const corpusThreadSchema = z.object({
  id: nonEmptyString,
  platform: z.enum(corpusPlatforms),
  accountId: nonEmptyString,
  title: optionalNonEmptyString,
  participantIds: z.array(nonEmptyString),
  messageIds: z.array(nonEmptyString),
  startedTs: z.number().int().min(CORPUS_CUTOFF_MS),
  latestTs: z.number().int().min(CORPUS_CUTOFF_MS),
});

export const corpusShardManifestEntrySchema = z.object({
  path: nonEmptyString,
  platform: z.enum(corpusPlatforms),
  accountId: nonEmptyString,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  count: z.number().int().nonnegative(),
  firstTs: z.number().int().min(CORPUS_CUTOFF_MS),
  lastTs: z.number().int().min(CORPUS_CUTOFF_MS),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const corpusManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: nonEmptyString,
  cutoffIso: z.literal(CORPUS_CUTOFF_ISO),
  shards: z.array(corpusShardManifestEntrySchema),
  totals: z.object({
    messages: z.number().int().nonnegative(),
    contacts: z.number().int().nonnegative().default(0),
    threads: z.number().int().nonnegative().default(0),
  }),
});

export type CorpusPlatform = (typeof corpusPlatforms)[number];
export type ScrubState = (typeof scrubStates)[number];
export type CorpusDirection = (typeof directions)[number];
export type CorpusRecipient = z.infer<typeof corpusRecipientSchema>;
export type CorpusAttachment = z.infer<typeof corpusAttachmentSchema>;
export type CorpusMessage = z.infer<typeof corpusMessageSchema>;
export type CorpusContact = z.infer<typeof corpusContactSchema>;
export type CorpusThread = z.infer<typeof corpusThreadSchema>;
export type CorpusShardManifestEntry = z.infer<
  typeof corpusShardManifestEntrySchema
>;
export type CorpusManifest = z.infer<typeof corpusManifestSchema>;

export const scrubStateRank: Readonly<Record<ScrubState, number>> = {
  raw: 0,
  mined: 1,
  swapped: 2,
  rewritten: 3,
  verified: 4,
};

export function assertScrubStateTransition(
  from: ScrubState,
  to: ScrubState,
): void {
  if (scrubStateRank[to] < scrubStateRank[from]) {
    throw new Error(`scrubState regressed from ${from} to ${to}`);
  }
}
