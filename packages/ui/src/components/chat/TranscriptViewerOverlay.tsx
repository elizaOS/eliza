/**
 * Full-screen overlay that opens a voice-transcript chat attachment: shows the
 * per-speaker segments (or plain text), plays the recorded audio, and supports
 * copy / download / share / inline edit / delete of the stored transcript record.
 *
 * The stored `transcriptId` is not always carried on the re-served attachment,
 * so it is also embedded as a leading HTML comment in the transcript markdown
 * (`TRANSCRIPT_MARKER`) that round-trips through the server's extracted `text`;
 * the viewer strips it for display and uses it to persist edits. Mounted from a
 * transcript attachment via `createPortal` at the shell-overlay z-layer.
 */
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import { transcriptPlainText } from "@elizaos/shared/transcripts";
import {
  Check,
  Copy,
  Download,
  FileAudio,
  Headphones,
  Pencil,
  Share2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import type { MessageAttachment } from "../../api";
import { client } from "../../api";
import { navigateBrowserPath } from "../../app-navigate-view";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { resolveApiUrl } from "../../utils/asset-url";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

const ABSOLUTE_URL = /^(?:https?:|data:|blob:|[a-z][a-z0-9+.-]*:\/\/)/i;

/** Resolve an attachment URL for fetch (absolute pass-through; `/api/…` joined). */
function resolveUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || ABSOLUTE_URL.test(trimmed)) return trimmed;
  return trimmed.startsWith("/") ? resolveApiUrl(trimmed) : trimmed;
}

/**
 * A durable link from the chat attachment back to the stored transcript record.
 * The client-only `transcriptId` field is dropped when the server re-serves the
 * attachment after a turn, so the record id is also embedded as a leading HTML
 * comment in the transcript markdown — which round-trips through the server in
 * the attachment's extracted `text`. The viewer strips it for display.
 */
const TRANSCRIPT_MARKER = /^<!--\s*eliza:transcript:([0-9a-f-]{36})\s*-->\n?/i;

/** Prepend the durable transcript-id marker to transcript markdown. */
export function withTranscriptMarker(id: string, text: string): string {
  return `<!-- eliza:transcript:${id} -->\n${text}`;
}

/** Split a transcript-id marker (if any) off the front of the text. */
function splitTranscriptMarker(text: string): {
  transcriptId?: string;
  text: string;
} {
  const m = TRANSCRIPT_MARKER.exec(text);
  if (!m) return { text };
  return { transcriptId: m[1], text: text.slice(m[0].length) };
}

/**
 * Maximized, editable transcript viewer. Opened by tapping a transcript chat
 * attachment ({@link MessageAttachments}). Loads the rich stored record when the
 * attachment carries a `transcriptId` (falling back to the attachment's inline
 * markdown text), lets the user edit the text, and offers: undo (restore the
 * loaded text), copy, share, save-to-files (download `.md`), cancel (discard +
 * close), and save-and-exit (persist the edit to the stored record + close).
 *
 * Rendered as a full-screen portal above the chat overlay (mirrors the image
 * lightbox in {@link MessageAttachments}). Brand-compliant: neutral controls on
 * a dark surface, accent only on the primary save action.
 */
export interface TranscriptViewerOverlayProps {
  attachment: MessageAttachment;
  onClose: () => void;
}

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      title: string;
      segments: TranscriptSegment[] | null;
      /** The stored record id this transcript can persist edits to, if any. */
      transcriptId: string | null;
      /** Served URL of the recorded audio (`/api/media/<hash>.wav`), if any. */
      audioUrl: string | null;
    };

/**
 * Copy-button feedback. `copied` only shows after a clipboard write actually
 * resolved; `failed` surfaces when the write rejected or the clipboard was
 * unavailable — so the button never claims success when nothing was copied.
 */
type CopyStatus = "idle" | "copied" | "failed";

function copyButtonLabel(status: CopyStatus): string {
  if (status === "copied") return "Copied";
  if (status === "failed") return "Copy failed";
  return "Copy";
}

/**
 * Pull the readable transcript text out of a not-yet-loaded attachment, with
 * the durable id marker (if present) split off. Prefers the server-extracted
 * `text`; falls back to decoding the `data:`/served URL.
 */
async function readInlineText(
  att: MessageAttachment,
): Promise<{ transcriptId?: string; text: string }> {
  if (att.text?.trim()) return splitTranscriptMarker(att.text);
  const src = resolveUrl(att.url);
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    const payload = comma >= 0 ? src.slice(comma + 1) : "";
    try {
      // data: URLs for text are base64 in our pipeline; decode best-effort.
      const raw = src.includes(";base64,")
        ? atob(payload)
        : decodeURIComponent(payload);
      return splitTranscriptMarker(raw);
    } catch {
      return { text: "" };
    }
  }
  try {
    const res = await fetch(src);
    if (res.ok) return splitTranscriptMarker(await res.text());
  } catch {
    // fall through to empty
  }
  return { text: "" };
}

/**
 * Rebuild segments from the edited plain text. When the edited line count
 * matches the original segments, each original segment keeps its timing +
 * words and only its text is replaced (the common "fix a typo" case). When the
 * structure changed, fall back to one segment per line (timing spread across
 * the original duration, no per-word timing — already frequently empty for the
 * on-device ASR). Lines are `Speaker: text` when the original had a label.
 */
export function segmentsFromEditedText(
  text: string,
  original: TranscriptSegment[],
): TranscriptSegment[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const parse = (line: string, label?: string) => {
    if (label) {
      const prefix = `${label}:`;
      if (line.toLowerCase().startsWith(prefix.toLowerCase())) {
        return line.slice(prefix.length).trim();
      }
    }
    const colon = line.indexOf(": ");
    return colon > 0 && colon <= 40 ? line.slice(colon + 2).trim() : line;
  };

  if (lines.length === original.length) {
    return original.map((seg, i) => ({
      ...seg,
      text: parse(lines[i], seg.speakerLabel),
      words: [],
    }));
  }

  const totalMs =
    original.length > 0
      ? (original.at(-1)?.endMs ?? lines.length * 1000)
      : lines.length * 1000;
  const per = totalMs / lines.length;
  return lines.map((line, i) => {
    const labelMatch = /^([^:]{1,40}):\s+(.*)$/.exec(line);
    return {
      id: `seg-${i}-${Math.round(per * i)}`,
      speakerLabel: labelMatch ? labelMatch[1].trim() : undefined,
      text: labelMatch ? labelMatch[2].trim() : line,
      startMs: Math.round(per * i),
      endMs: Math.round(per * (i + 1)),
      words: [],
    };
  });
}

export function TranscriptViewerOverlay({
  attachment,
  onClose,
}: TranscriptViewerOverlayProps): React.JSX.Element | null {
  const [load, setLoad] = React.useState<LoadState>({ status: "loading" });
  const [pristine, setPristine] = React.useState("");
  const [value, setValue] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [copyStatus, setCopyStatus] = React.useState<CopyStatus>("idle");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const audioUrl =
    load.status === "ready" && load.audioUrl ? resolveUrl(load.audioUrl) : null;

  const dirty = value !== pristine;
  const title =
    load.status === "ready"
      ? load.title
      : attachment.title?.trim() || "Transcript";

  // Load the rich record (or the inline text) once.
  React.useEffect(() => {
    let live = true;
    void (async () => {
      const inline = await readInlineText(attachment);
      const id = attachment.transcriptId ?? inline.transcriptId;
      if (id) {
        try {
          const { transcript } = await client.getTranscript(id);
          if (!live) return;
          const text = transcriptPlainText(transcript.segments);
          setLoad({
            status: "ready",
            title: transcript.title,
            segments: transcript.segments,
            transcriptId: id,
            audioUrl: transcript.audioUrl ?? null,
          });
          setPristine(text);
          setValue(text);
          return;
        } catch {
          // record gone/unreachable — fall back to the inline text.
        }
      }
      if (!live) return;
      setLoad({
        status: "ready",
        title: attachment.title?.trim() || "Transcript",
        segments: null,
        transcriptId: id ?? null,
        audioUrl: null,
      });
      setPristine(inline.text);
      setValue(inline.text);
    })();
    return () => {
      live = false;
    };
  }, [attachment]);

  // Escape closes (cancel/discard).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = React.useCallback(async (): Promise<boolean> => {
    try {
      // Optional chaining alone is a trap: `navigator.clipboard?.writeText(v)`
      // is `undefined` (not a rejection) when the clipboard API is missing, so
      // `await` resolves and we'd falsely report "Copied". Require the method.
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1500);
      return true;
    } catch {
      // Clipboard blocked/missing (e.g. insecure context) — surface the failure
      // (share/download remain as alternatives) instead of a phantom success.
      setCopyStatus("failed");
      window.setTimeout(() => setCopyStatus("idle"), 2500);
      return false;
    }
  }, [value]);

  const handleShare = React.useCallback(async () => {
    const nav = navigator as Navigator & {
      share?: (data: { title?: string; text?: string }) => Promise<void>;
    };
    if (nav.share) {
      try {
        await nav.share({ title, text: value });
        return;
      } catch (err) {
        // User-cancelled share is not an error; anything else falls to copy.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    await handleCopy();
  }, [title, value, handleCopy]);

  const handleSaveToFiles = React.useCallback(() => {
    const safe = title.replace(/[^\w.-]+/g, "_").slice(0, 80) || "transcript";
    const blob = new Blob([value], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [title, value]);

  const audioFileName = `${
    title.replace(/[^\w.-]+/g, "_").slice(0, 80) || "transcript"
  }.wav`;

  const handleDownloadAudio = React.useCallback(() => {
    if (!audioUrl) return;
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = audioFileName;
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [audioUrl, audioFileName]);

  const handleShareAudio = React.useCallback(async () => {
    if (!audioUrl) return;
    const nav = navigator as Navigator & {
      share?: (data: {
        title?: string;
        files?: File[];
        url?: string;
      }) => Promise<void>;
      canShare?: (data: { files?: File[] }) => boolean;
    };
    // Prefer sharing the actual audio file where the platform supports it.
    try {
      if (nav.share && nav.canShare) {
        const res = await fetch(audioUrl);
        if (res.ok) {
          const file = new File([await res.blob()], audioFileName, {
            type: "audio/wav",
          });
          if (nav.canShare({ files: [file] })) {
            await nav.share({ title, files: [file] });
            return;
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
    // Fall back to sharing the URL, then to downloading it.
    try {
      if (nav.share) {
        await nav.share({ title, url: audioUrl });
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
    handleDownloadAudio();
  }, [audioUrl, audioFileName, title, handleDownloadAudio]);

  const handleOpenInTranscripts = React.useCallback(() => {
    // The Transcripts view plays the audio (word-synced) — land there to listen.
    navigateBrowserPath("/apps/transcripts");
    onClose();
  }, [onClose]);

  const resolvedId = load.status === "ready" ? load.transcriptId : null;

  const handleDelete = React.useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    if (resolvedId) {
      try {
        await client.deleteTranscript(resolvedId);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Couldn't delete");
        return;
      }
    }
    onClose();
  }, [confirmDelete, resolvedId, onClose]);

  const handleSaveAndExit = React.useCallback(async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (!resolvedId || load.status !== "ready") {
      // No stored record to persist to — keep the edit out of the void by
      // downloading it, then close.
      handleSaveToFiles();
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const segments = segmentsFromEditedText(value, load.segments ?? []);
      await client.updateTranscript(resolvedId, { segments });
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Couldn't save");
      setSaving(false);
    }
  }, [dirty, resolvedId, load, value, onClose, handleSaveToFiles]);

  if (typeof document === "undefined") return null;

  const canPersist = !!resolvedId;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Transcript: ${title}`}
      data-testid="transcript-viewer"
      className="fixed inset-0 flex items-center justify-center p-4 sm:p-6"
      style={{
        zIndex: Z_SHELL_OVERLAY + 10,
        paddingTop: "calc(var(--safe-area-top, 0px) + 1rem)",
      }}
    >
      <Button
        aria-label="Close transcript"
        onClick={onClose}
        variant="ghost"
        className="absolute inset-0 h-auto w-auto cursor-default rounded-none bg-black/85 hover:bg-black/85"
      />
      <div
        className={cn(
          "relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden",
          "rounded-2xl border border-white/15 bg-[rgb(22,22,28)] text-white",
        )}
      >
        {/* Header: title + close */}
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </h2>
          <Button
            aria-label="Close"
            onClick={onClose}
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {audioUrl ? (
            // Listen to the real recorded audio inline (the Transcripts view
            // adds word-synced playback — "Open in Transcripts" below). The
            // recording's own save/share sit with the player, so the footer
            // stays about the transcript text.
            <div className="mb-3 space-y-1.5">
              <audio
                src={audioUrl}
                controls
                preload="metadata"
                data-testid="transcript-audio"
                className="w-full"
              >
                <track kind="captions" />
              </audio>
              <div className="flex items-center gap-1 text-xs text-white/50">
                <FileAudio className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="mr-1">Recording</span>
                <Button
                  onClick={handleDownloadAudio}
                  data-testid="transcript-save-audio"
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded px-1.5 py-0.5 text-xs font-normal text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Download
                </Button>
                <Button
                  onClick={() => void handleShareAudio()}
                  data-testid="transcript-share-audio"
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded px-1.5 py-0.5 text-xs font-normal text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Share
                </Button>
              </div>
            </div>
          ) : null}
          {load.status === "loading" ? (
            <div className="flex items-center gap-2 py-8 text-sm text-white/60">
              <Spinner size={16} /> Loading transcript…
            </div>
          ) : editing ? (
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Edit transcript"
              data-testid="transcript-editor"
              className="min-h-[40vh] w-full resize-none border-white/15 bg-black/30 text-[13px] leading-relaxed text-white"
              autoFocus
            />
          ) : (
            <pre
              data-testid="transcript-text"
              className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-white/90"
            >
              {value || "(empty transcript)"}
            </pre>
          )}
          {saveError ? (
            <p
              className="mt-2 text-xs text-[color:var(--danger,#f87171)]"
              data-testid="transcript-save-error"
            >
              {saveError}
            </p>
          ) : null}
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3">
          {!editing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="transcript-edit"
              className="text-white/85 hover:bg-white/10"
            >
              <Pencil className="mr-1.5 h-4 w-4" /> Edit
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setValue(pristine)}
              disabled={!dirty}
              data-testid="transcript-undo"
              className="text-white/85 hover:bg-white/10"
            >
              <Undo2 className="mr-1.5 h-4 w-4" /> Undo
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCopy()}
            data-testid="transcript-copy"
            className={cn(
              "hover:bg-white/10",
              copyStatus === "failed"
                ? "text-[color:var(--danger,#f87171)]"
                : "text-white/85",
            )}
          >
            {copyStatus === "copied" ? (
              <Check className="mr-1.5 h-4 w-4 text-[color:var(--ok)]" />
            ) : (
              <Copy className="mr-1.5 h-4 w-4" />
            )}
            {copyButtonLabel(copyStatus)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleShare}
            data-testid="transcript-share"
            className="text-white/85 hover:bg-white/10"
          >
            <Share2 className="mr-1.5 h-4 w-4" /> Share
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSaveToFiles}
            data-testid="transcript-save-to-files"
            className="text-white/85 hover:bg-white/10"
          >
            <Download className="mr-1.5 h-4 w-4" /> Download
          </Button>
          {resolvedId || audioUrl ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenInTranscripts}
              data-testid="transcript-open-in-transcripts"
              className="text-white/85 hover:bg-white/10"
            >
              <Headphones className="mr-1.5 h-4 w-4" /> Open in Transcripts
            </Button>
          ) : null}
          {resolvedId ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleDelete()}
              data-testid="transcript-delete"
              className={cn(
                "hover:bg-[color:var(--danger,#f87171)]/15",
                confirmDelete
                  ? "text-[color:var(--danger,#f87171)]"
                  : "text-white/70",
              )}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {confirmDelete ? "Confirm delete" : "Delete"}
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              data-testid="transcript-cancel"
              className="text-white/70 hover:bg-white/10"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleSaveAndExit()}
              disabled={saving || (editing && !dirty && canPersist)}
              data-testid="transcript-save-exit"
            >
              {saving ? "Saving…" : "Save & exit"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
