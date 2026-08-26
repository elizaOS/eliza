/**
 * Media-format facets for the folded Knowledge hub (#13594): the single vocabulary
 * that classifies every knowledge record by how it should be read, shared by the
 * hub's facet control, its list rows, and the reader's per-mimeType branch.
 *
 * Classification is derived at read time from the record's `contentType` (mime) plus
 * the transcript-backed signal (`transcriptId`), never from a stored column — the
 * same mime-derivation principle the media store uses (#8876: no second store, no
 * new ContentType). The server's own `media-format:<format>` tag/`metadata.mediaFormat`
 * (from the slice-1 ingest pipeline, #13593) stays the search-side facet; this is the
 * client display/narrowing facet and the two agree on the same names.
 */

import {
  AudioLines,
  FileText,
  Film,
  ImageIcon,
  Layers,
  Mic,
} from "lucide-react";
import type { DocumentRecord } from "@elizaos/ui/api";

/** A concrete media-format facet (excludes the "all" pseudo-facet). */
export type KnowledgeMediaFormat =
  | "doc"
  | "image"
  | "audio"
  | "video"
  | "transcript";

/** The facet control's value: a concrete format or the "all" pseudo-facet. */
export type KnowledgeFacet = "all" | KnowledgeMediaFormat;

/** Facet order shown in the top-bar segmented control (All first). */
export const KNOWLEDGE_FACETS: readonly KnowledgeFacet[] = [
  "all",
  "doc",
  "image",
  "audio",
  "video",
  "transcript",
];

const FACET_ICON: Record<KnowledgeFacet, typeof Layers> = {
  all: Layers,
  doc: FileText,
  image: ImageIcon,
  audio: AudioLines,
  video: Film,
  transcript: Mic,
};

/** The lucide icon for a facet (and, reused, for a list row of that format). */
export function knowledgeFacetIcon(facet: KnowledgeFacet): typeof Layers {
  return FACET_ICON[facet];
}

const FACET_LABEL_KEY: Record<
  KnowledgeFacet,
  { key: string; defaultLabel: string }
> = {
  all: { key: "knowledgehub.facet.all", defaultLabel: "All" },
  doc: { key: "knowledgehub.facet.docs", defaultLabel: "Docs" },
  image: { key: "knowledgehub.facet.images", defaultLabel: "Images" },
  audio: { key: "knowledgehub.facet.audio", defaultLabel: "Audio" },
  video: { key: "knowledgehub.facet.video", defaultLabel: "Video" },
  transcript: {
    key: "knowledgehub.facet.transcripts",
    defaultLabel: "Transcripts",
  },
};

/** Translated label for a facet, with an English default. */
export function knowledgeFacetLabel(
  facet: KnowledgeFacet,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const { key, defaultLabel } = FACET_LABEL_KEY[facet];
  return t(key, { defaultValue: defaultLabel });
}

function mimeOf(contentType: string | undefined): string {
  return (contentType || "").split(";")[0].trim().toLowerCase();
}

/**
 * Classify a document into its media format. A transcript-backed record (one that
 * mirrors a voice Transcript, #8789) is always the `transcript` facet regardless of
 * its stored mime; otherwise the mime prefix decides, and everything non-media
 * (pdf, text, markdown, json, …) is a `doc`.
 */
export function documentMediaFormat(doc: DocumentRecord): KnowledgeMediaFormat {
  if (doc.transcriptId) return "transcript";
  const mime = mimeOf(doc.contentType);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "doc";
}

/** True when a record belongs to the selected facet (`all` matches everything). */
export function documentMatchesFacet(
  doc: DocumentRecord,
  facet: KnowledgeFacet,
): boolean {
  return facet === "all" || documentMediaFormat(doc) === facet;
}

/** Per-facet counts over a document list, including the `all` total. */
export function knowledgeFacetCounts(
  docs: readonly DocumentRecord[],
): Record<KnowledgeFacet, number> {
  const counts: Record<KnowledgeFacet, number> = {
    all: docs.length,
    doc: 0,
    image: 0,
    audio: 0,
    video: 0,
    transcript: 0,
  };
  for (const doc of docs) counts[documentMediaFormat(doc)] += 1;
  return counts;
}

/**
 * Reader-side rendering kind for a document's original served bytes. A
 * transcript-backed audio record reads as `transcript` (word-synced player);
 * plain media reads by mime; anything else is prose/paged text. Kept separate
 * from {@link documentMediaFormat} because `doc` splits into `pdf` vs `text` for
 * the reader, which the list facet does not care about.
 */
export type KnowledgeReaderKind =
  | "transcript"
  | "audio"
  | "image"
  | "video"
  | "pdf"
  | "text";

export function knowledgeReaderKind(doc: {
  contentType?: string;
  transcriptId?: string;
}): KnowledgeReaderKind {
  if (doc.transcriptId) return "transcript";
  const mime = mimeOf(doc.contentType);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "text";
}
