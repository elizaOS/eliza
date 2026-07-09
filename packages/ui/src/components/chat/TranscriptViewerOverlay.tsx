/**
 * Full-screen overlay that opens a voice-transcript chat attachment: shows the
 * per-speaker segments (or plain text), plays the recorded audio, and exposes a
 * small permission-aware toolset for copying, editing, sharing, and deleting the
 * stored transcript record.
 *
 * Stored records are addressed only by the attachment's structured
 * `transcriptId`; inline markdown is a fallback display body, not an id carrier.
 * Mounted from a transcript attachment via `createPortal` at the shell-overlay
 * z-layer.
 */
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import { transcriptPlainText } from "@elizaos/shared/transcripts";
import {
  Check,
  Copy,
  Download,
  FileAudio,
  Headphones,
  Loader2,
  LockKeyhole,
  Pencil,
  Share2,
  ShieldCheck,
  Trash2,
  Undo2,
  UserRoundMinus,
  X,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import type { MessageAttachment } from "../../api";
import { client } from "../../api";
import { navigateBrowserPath } from "../../app-navigate-view";
import { useRole } from "../../hooks/useRole";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { resolveApiUrl } from "../../utils/asset-url";
import { RoleGate } from "../RoleGate";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
 * Maximized, editable transcript viewer. Opened by tapping a transcript chat
 * attachment ({@link MessageAttachments}). Loads the rich stored record when the
 * attachment carries a `transcriptId` (falling back to the attachment's inline
 * markdown text), lets the user edit the text, and offers a compact action set:
 * copy, permission-aware share request, edit/save, open in Transcripts, and
 * delete-for-everyone for the stored record.
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
  | { status: "error"; message: string }
  | {
      status: "ready";
      title: string;
      segments: TranscriptSegment[] | null;
      /** The stored record id this transcript can persist edits to, if any. */
      transcriptId: string | null;
      /** Served URL of the recorded audio (`/api/media/<hash>.wav`), if any. */
      audioUrl: string | null;
      redacted: boolean;
    };

/**
 * Copy-button feedback. `copied` only shows after a clipboard write actually
 * resolved; `failed` surfaces when the write rejected or the clipboard was
 * unavailable — so the button never claims success when nothing was copied.
 */
type CopyStatus = "idle" | "copied" | "failed";
type ShareMode = "redacted" | "full";
type ShareStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; message: string; entityId: string }
  | { kind: "error"; message: string };

function copyButtonLabel(status: CopyStatus): string {
  if (status === "copied") return "Copied";
  if (status === "failed") return "Copy failed";
  return "Copy";
}

/**
 * Pull the readable transcript text out of a not-yet-loaded attachment. Prefers
 * the server-extracted `text`; falls back to decoding the `data:`/served URL.
 */
async function readInlineText(
  att: MessageAttachment,
): Promise<{ text: string; loadFailed?: boolean }> {
  if (att.text?.trim()) return { text: att.text };
  const src = resolveUrl(att.url);
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    const payload = comma >= 0 ? src.slice(comma + 1) : "";
    try {
      // data: URLs for text are base64 in our pipeline; decode best-effort.
      const raw = src.includes(";base64,")
        ? atob(payload)
        : decodeURIComponent(payload);
      return { text: raw };
    } catch {
      // error-policy:J3 corrupt inline payload — flag the failure so the
      // viewer can render an error instead of a healthy-empty transcript
      return { text: "", loadFailed: true };
    }
  }
  try {
    const res = await fetch(src);
    if (res.ok) return { text: await res.text() };
  } catch {
    // error-policy:J4 transport failure — flagged below; the viewer renders
    // an error state when no stored record covers for it
  }
  return { text: "", loadFailed: true };
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
  const { isAdmin } = useRole();
  const [load, setLoad] = React.useState<LoadState>({ status: "loading" });
  const [pristine, setPristine] = React.useState("");
  const [value, setValue] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareMode, setShareMode] = React.useState<ShareMode>("redacted");
  const [shareTarget, setShareTarget] = React.useState("");
  const [shareStatus, setShareStatus] = React.useState<ShareStatus>({
    kind: "idle",
  });
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
      const id = attachment.transcriptId;
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
            redacted: transcript.redacted === true,
          });
          setPristine(text);
          setValue(text);
          return;
        } catch {
          // error-policy:J4 record gone/unreachable — fall back to the inline
          // text below (or the error render when that failed too).
        }
      }
      if (!live) return;
      if (inline.loadFailed && !inline.text) {
        // Never render "(empty transcript)" for a transcript we failed to
        // read — loading, empty, and error must stay distinguishable.
        setLoad({
          status: "error",
          message: "Couldn't load this transcript. Close and try again.",
        });
        return;
      }
      setLoad({
        status: "ready",
        title: attachment.title?.trim() || "Transcript",
        segments: null,
        transcriptId: id ?? null,
        audioUrl: null,
        redacted: false,
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
      // error-policy:J4 clipboard blocked/missing (e.g. insecure context) —
      // surface the failure (share/download remain as alternatives) instead of
      // a phantom success.
      setCopyStatus("failed");
      window.setTimeout(() => setCopyStatus("idle"), 2500);
      return false;
    }
  }, [value]);

  React.useEffect(() => {
    if (!isAdmin && shareMode === "full") setShareMode("redacted");
  }, [isAdmin, shareMode]);

  const handleGrantShare = React.useCallback(async () => {
    if (load.status !== "ready" || !load.transcriptId) return;
    const entityId = shareTarget.trim();
    if (!entityId) {
      setShareStatus({ kind: "error", message: "Add a recipient entity ID." });
      return;
    }
    setShareStatus({ kind: "submitting" });
    try {
      const result = await client.shareTranscript(load.transcriptId, {
        entityId,
        mode: shareMode,
      });
      setShareStatus({
        kind: "success",
        entityId: result.entityId,
        message:
          result.mode === "full"
            ? "Full transcript access granted."
            : "Redacted transcript access granted.",
      });
    } catch (err) {
      setShareStatus({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Couldn't share transcript.",
      });
    }
  }, [load, shareMode, shareTarget]);

  const handleRevokeShare = React.useCallback(async () => {
    if (load.status !== "ready" || !load.transcriptId) return;
    const entityId =
      shareStatus.kind === "success"
        ? shareStatus.entityId
        : shareTarget.trim();
    if (!entityId) {
      setShareStatus({ kind: "error", message: "Add a recipient entity ID." });
      return;
    }
    setShareStatus({ kind: "submitting" });
    try {
      await client.revokeTranscriptShare(load.transcriptId, entityId);
      setShareStatus({
        kind: "success",
        entityId,
        message: "Transcript access revoked for that recipient.",
      });
    } catch (err) {
      setShareStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Couldn't revoke access.",
      });
    }
  }, [load, shareStatus, shareTarget]);

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
        // error-policy:J4 failed delete renders the error line and keeps the
        // overlay open — the transcript never silently looks deleted
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
      // error-policy:J4 failed save renders the error line; the edit stays
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
        className="absolute inset-0 h-auto w-auto cursor-default rounded-none bg-scrim hover:bg-scrim"
      />
      <div
        className={cn(
          "relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden",
          "rounded-lg border border-border bg-card text-txt",
        )}
      >
        {/* Header: title + close */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-txt-strong">
            {title}
          </h2>
          <Badge
            variant="outline"
            className="hidden shrink-0 items-center gap-1 border-border/70 bg-bg/45 font-normal text-muted sm:inline-flex"
          >
            <LockKeyhole className="h-3 w-3" aria-hidden />
            Private
          </Badge>
          {load.status === "ready" && load.redacted ? (
            <Badge
              variant="secondary"
              className="shrink-0 items-center gap-1 bg-bg-accent text-txt"
              data-testid="transcript-redacted-badge"
            >
              <ShieldCheck className="h-3 w-3" aria-hidden />
              Redacted
            </Badge>
          ) : null}
          <Button
            aria-label="Close"
            onClick={onClose}
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 rounded-full bg-bg-hover text-muted transition-colors hover:bg-surface hover:text-txt active:scale-[0.96] motion-reduce:active:scale-100"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
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
              <div className="flex items-center gap-1 text-xs text-muted">
                <FileAudio
                  className="h-3.5 w-3.5 shrink-0"
                  strokeWidth={1.5}
                  aria-hidden
                />
                <span>Recording retained</span>
              </div>
            </div>
          ) : null}
          {load.status === "loading" ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted">
              <Spinner size={16} /> Loading transcript…
            </div>
          ) : load.status === "error" ? (
            <p
              className="py-8 text-sm text-[color:var(--danger,#f87171)]"
              data-testid="transcript-load-error"
            >
              {load.message}
            </p>
          ) : editing ? (
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Edit transcript"
              data-testid="transcript-editor"
              className="min-h-[40vh] w-full resize-none border-border bg-bg text-xs-tight leading-relaxed text-txt"
              autoFocus
            />
          ) : (
            <pre
              data-testid="transcript-text"
              className="whitespace-pre-wrap break-words font-sans text-xs-tight leading-relaxed text-txt"
            >
              {value || "(empty transcript)"}
            </pre>
          )}
          {saveError ? (
            <p
              className="mt-2 text-xs text-danger"
              data-testid="transcript-save-error"
            >
              {saveError}
            </p>
          ) : null}
          {shareOpen ? (
            <div
              className="mt-4 rounded-sm border border-border bg-bg/45 p-3"
              data-testid="transcript-share-sheet"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Share2 className="h-4 w-4 text-muted" aria-hidden />
                <p className="min-w-0 flex-1 text-xs font-medium text-txt">
                  Share access
                </p>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
                <label
                  htmlFor="transcript-share-target"
                  className="grid gap-1 text-xs text-muted"
                >
                  Recipient entity ID
                  <Input
                    id="transcript-share-target"
                    value={shareTarget}
                    onChange={(event) => {
                      setShareTarget(event.target.value);
                      setShareStatus({ kind: "idle" });
                    }}
                    placeholder="Entity ID"
                    density="compact"
                    data-testid="transcript-share-target"
                    className="font-mono text-[11px]"
                  />
                </label>
                <div className="grid content-end gap-1">
                  <fieldset className="inline-flex rounded-sm border border-border bg-card p-0.5">
                    <legend className="sr-only">
                      Transcript disclosure mode
                    </legend>
                    <Button
                      variant={shareMode === "redacted" ? "default" : "ghost"}
                      size="sm"
                      className="h-8 rounded-sm px-3 text-xs"
                      onClick={() => {
                        setShareMode("redacted");
                        setShareStatus({ kind: "idle" });
                      }}
                      data-testid="transcript-share-mode-redacted"
                    >
                      Redacted
                    </Button>
                    <RoleGate
                      minRole="ADMIN"
                      fallback={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 rounded-sm px-3 text-xs"
                          disabled
                          data-testid="transcript-share-mode-full-disabled"
                        >
                          Full
                        </Button>
                      }
                    >
                      <Button
                        variant={shareMode === "full" ? "default" : "ghost"}
                        size="sm"
                        className="h-8 rounded-sm px-3 text-xs"
                        onClick={() => {
                          setShareMode("full");
                          setShareStatus({ kind: "idle" });
                        }}
                        data-testid="transcript-share-mode-full"
                      >
                        Full
                      </Button>
                    </RoleGate>
                  </fieldset>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void handleGrantShare()}
                  disabled={
                    shareStatus.kind === "submitting" ||
                    load.status !== "ready" ||
                    !load.transcriptId ||
                    !shareTarget.trim()
                  }
                  data-testid="transcript-grant-share"
                >
                  {shareStatus.kind === "submitting" ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Share2 className="mr-1.5 h-4 w-4" />
                  )}
                  Grant
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRevokeShare()}
                  disabled={
                    shareStatus.kind === "submitting" ||
                    load.status !== "ready" ||
                    !load.transcriptId ||
                    !shareTarget.trim()
                  }
                  data-testid="transcript-revoke-share"
                >
                  <UserRoundMinus className="mr-1.5 h-4 w-4" />
                  Revoke
                </Button>
                <p className="min-w-[12rem] flex-1 text-xs text-muted">
                  Room roster and connector contacts are unavailable here; use
                  an entity ID. People who already opened it may have kept a
                  copy.
                </p>
              </div>
              {shareStatus.kind === "error" ? (
                <p
                  className="mt-2 break-words text-xs text-danger"
                  data-testid="transcript-share-error"
                >
                  {shareStatus.message}
                </p>
              ) : shareStatus.kind === "success" ? (
                <p
                  className="mt-2 break-words text-xs text-status-success"
                  data-testid="transcript-share-success"
                >
                  {shareStatus.message}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Action bar */}
        <div
          className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3"
          style={{
            paddingBottom: "calc(var(--safe-area-bottom, 0px) + 0.75rem)",
          }}
        >
          {!editing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="transcript-edit"
            >
              <Pencil className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> Edit
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setValue(pristine)}
              disabled={!dirty}
              data-testid="transcript-undo"
            >
              <Undo2 className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> Undo
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCopy()}
            data-testid="transcript-copy"
            className={cn(copyStatus === "failed" && "text-danger")}
          >
            {copyStatus === "copied" ? (
              <Check
                className="mr-1.5 h-4 w-4 text-status-success"
                strokeWidth={1.5}
              />
            ) : (
              <Copy className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            )}
            {copyButtonLabel(copyStatus)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShareOpen((open) => !open);
              setShareStatus({ kind: "idle" });
            }}
            data-testid="transcript-share"
          >
            <Share2 className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> Share
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSaveToFiles}
            data-testid="transcript-save-to-files"
          >
            <Download className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> Download
          </Button>
          {resolvedId || audioUrl ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenInTranscripts}
              data-testid="transcript-open-in-transcripts"
            >
              <Headphones className="mr-1.5 h-4 w-4" strokeWidth={1.5} /> Open
              in Transcripts
            </Button>
          ) : null}
          {resolvedId ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleDelete()}
              data-testid="transcript-delete"
              className={cn(
                "hover:bg-destructive-subtle",
                confirmDelete ? "text-danger" : "text-muted",
              )}
            >
              <Trash2 className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
              {confirmDelete
                ? "Confirm delete for everyone"
                : "Delete for everyone"}
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              data-testid="transcript-cancel"
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
