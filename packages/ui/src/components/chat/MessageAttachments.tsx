import {
  Download,
  FileText,
  LinkIcon,
  Maximize2,
  ScrollText,
  X,
} from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import type {
  MessageAttachment,
  MessageAttachmentContentType,
} from "../../api";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { resolveApiUrl } from "../../utils/asset-url";
import { isSafeAttachmentUrl } from "../../utils/attachment-url";
import { TranscriptViewerOverlay } from "./TranscriptViewerOverlay";

const ABSOLUTE_URL = /^(?:https?:|data:|blob:|[a-z][a-z0-9+.-]*:\/\/)/i;

/**
 * Resolve an attachment URL for rendering. Absolute URLs (http(s), data:,
 * blob:, custom schemes) pass through untouched; an app-relative `/api/...`
 * path (a served `/api/media/<hash>`) is joined to the active API base so it
 * loads across the dev proxy, prod same-origin, and desktop/native shells.
 */
export function resolveAttachmentUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (ABSOLUTE_URL.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return resolveApiUrl(trimmed);
  return trimmed;
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#]|$)/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v|ogv)(?:[?#]|$)/i;
const AUDIO_EXT = /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|opus)(?:[?#]|$)/i;
const DOC_EXT = /\.(?:pdf|docx?|pptx?|xlsx?|txt|csv|md|json)(?:[?#]|$)/i;

/**
 * Resolve the effective media kind. Prefer the explicit `contentType`, then the
 * MIME type, then fall back to extension / data-URL sniffing so attachments
 * from connectors that omit `contentType` still render with the right player.
 */
function resolveKind(att: MessageAttachment): MessageAttachmentContentType {
  if (att.contentType) return att.contentType;
  const mime = att.mimeType ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/")) return "document";
  const u = att.url.toLowerCase();
  if (IMAGE_EXT.test(u) || u.startsWith("data:image/")) return "image";
  if (VIDEO_EXT.test(u) || u.startsWith("data:video/")) return "video";
  if (AUDIO_EXT.test(u) || u.startsWith("data:audio/")) return "audio";
  if (DOC_EXT.test(u) || u.startsWith("data:application/")) return "document";
  return "link";
}

/**
 * A transcript attachment: a saved transcript record (carries `transcriptId`)
 * or, for older attachments produced before the link existed, a markdown
 * attachment whose title reads as a transcript. These open the maximized,
 * editable {@link TranscriptViewerOverlay} instead of downloading.
 */
function isTranscriptAttachment(att: MessageAttachment): boolean {
  if (att.transcriptId) return true;
  const mime = att.mimeType ?? "";
  const title = att.title?.trim() ?? "";
  return mime === "text/markdown" && /transcript/i.test(title);
}

function attachmentLabel(att: MessageAttachment): string {
  if (att.title?.trim()) return att.title.trim();
  try {
    const u = att.url.startsWith("data:")
      ? ""
      : new URL(att.url, "http://x").pathname;
    const base = u.split("/").filter(Boolean).at(-1);
    if (base) return decodeURIComponent(base);
  } catch {
    // fall through
  }
  return "attachment";
}

function downloadName(att: MessageAttachment, kind: string): string {
  const label = attachmentLabel(att);
  if (label !== "attachment") return label;
  const ext =
    kind === "image"
      ? "png"
      : kind === "audio"
        ? "mp3"
        : kind === "video"
          ? "mp4"
          : "bin";
  return `${att.id || "attachment"}.${ext}`;
}

/** A neutral circular control button (download / expand). Orange-free per brand. */
function TileButton({
  label,
  onClick,
  href,
  download,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  download?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const cls = cn(
    "inline-flex h-7 w-7 items-center justify-center rounded-full",
    "bg-black/45 text-white/90 backdrop-blur-sm transition-colors",
    "hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
  );
  if (href) {
    return (
      <a
        href={href}
        download={download}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        title={label}
        className={cls}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cls}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

function ImageTile({
  att,
  src,
  thumbSrc,
  onExpand,
}: {
  att: MessageAttachment;
  src: string;
  thumbSrc: string;
  onExpand: () => void;
}): React.JSX.Element {
  const label = attachmentLabel(att);
  return (
    <div className="group relative inline-block max-w-[min(20rem,100%)] overflow-hidden rounded-xl border border-white/12">
      <button
        type="button"
        onClick={onExpand}
        className="block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        aria-label={`Expand image ${label}`}
      >
        <img
          src={thumbSrc}
          alt={att.description?.trim() || label}
          loading="lazy"
          // Reserve a stable box via aspect-ratio so the row height is fixed
          // before the image loads — avoids layout shift / scroll-anchor yank.
          // The type carries no intrinsic dimensions, so a 4:3 default is used.
          className="block aspect-[4/3] max-h-80 w-full object-cover"
        />
      </button>
      <div className="pointer-events-none absolute right-1.5 top-1.5 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="pointer-events-auto">
          <TileButton label="Expand image" onClick={onExpand}>
            <Maximize2 className="h-3.5 w-3.5" />
          </TileButton>
        </span>
        <span className="pointer-events-auto">
          <TileButton
            label="Download image"
            href={src}
            download={downloadName(att, "image")}
          >
            <Download className="h-3.5 w-3.5" />
          </TileButton>
        </span>
      </div>
    </div>
  );
}

function FileTile({
  att,
  src,
  kind,
}: {
  att: MessageAttachment;
  src: string;
  kind: string;
}): React.JSX.Element {
  const label = attachmentLabel(att);
  const Icon = kind === "link" ? LinkIcon : FileText;
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      download={kind === "link" ? undefined : downloadName(att, kind)}
      className={cn(
        "flex max-w-[min(20rem,100%)] items-center gap-2.5 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5",
        "text-white/90 transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
      )}
    >
      <Icon className="h-5 w-5 shrink-0 text-white/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        {att.description?.trim() ? (
          <span className="block truncate text-[11px] text-white/55">
            {att.description.trim()}
          </span>
        ) : (
          <span className="block text-[11px] uppercase tracking-wide text-white/45">
            {kind === "link" ? "link" : kind}
          </span>
        )}
      </span>
      {kind === "link" ? (
        <LinkIcon className="h-4 w-4 shrink-0 text-white/55" />
      ) : (
        <Download className="h-4 w-4 shrink-0 text-white/55" />
      )}
    </a>
  );
}

/**
 * A non-clickable fallback card for an attachment whose URL fails the scheme
 * allowlist ({@link isSafeAttachmentUrl}) — e.g. a `javascript:` / `file:` /
 * `data:text/html` URL injected by an untrusted agent. It shows the same chrome
 * as {@link FileTile} but renders no `href` / `src`, so the dangerous URL is
 * never handed to the browser.
 */
function UnsafeAttachmentTile({
  att,
}: {
  att: MessageAttachment;
}): React.JSX.Element {
  const label = attachmentLabel(att);
  return (
    <div
      data-testid="unsafe-attachment"
      className={cn(
        "flex max-w-[min(20rem,100%)] items-center gap-2.5 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5",
        "text-white/90",
      )}
    >
      <FileText className="h-5 w-5 shrink-0 text-white/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        <span className="block text-[11px] uppercase tracking-wide text-white/45">
          unsupported attachment
        </span>
      </span>
    </div>
  );
}

/** A transcript tile — tap to open the maximized, editable transcript viewer. */
function TranscriptTile({
  att,
  onOpen,
}: {
  att: MessageAttachment;
  onOpen: () => void;
}): React.JSX.Element {
  const label = attachmentLabel(att);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="transcript-attachment"
      className={cn(
        "group flex max-w-[min(20rem,100%)] items-center gap-2.5 rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5 text-left",
        "text-white/90 transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
      )}
    >
      <ScrollText className="h-5 w-5 shrink-0 text-white/70" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        <span className="block text-[11px] uppercase tracking-wide text-white/45">
          Transcript · tap to open
        </span>
      </span>
      <Maximize2 className="h-4 w-4 shrink-0 text-white/55 transition-colors group-hover:text-white/80" />
    </button>
  );
}

function Lightbox({
  src,
  alt,
  downloadAs,
  onClose,
}: {
  src: string;
  alt: string;
  downloadAs: string;
  onClose: () => void;
}): React.JSX.Element | null {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      data-testid="attachment-lightbox"
      className="fixed inset-0 flex items-center justify-center p-6"
      style={{ zIndex: Z_SHELL_OVERLAY + 10 }}
    >
      {/* Full-screen backdrop is a real button so click + keyboard both close;
          the image and controls sit above it as siblings. */}
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute inset-0 cursor-zoom-out bg-black/85 backdrop-blur-sm"
      />
      <img
        src={src}
        alt={alt}
        // pointer-events fall through to the backdrop button, so clicking the
        // image closes too — standard lightbox behaviour.
        className="pointer-events-none relative max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
      <div className="absolute right-4 top-4 flex gap-2">
        <TileButton label="Download image" href={src} download={downloadAs}>
          <Download className="h-4 w-4" />
        </TileButton>
        <TileButton label="Close" onClick={onClose}>
          <X className="h-4 w-4" />
        </TileButton>
      </div>
    </div>,
    document.body,
  );
}

export interface MessageAttachmentsProps {
  attachments: MessageAttachment[] | undefined;
  className?: string;
}

/**
 * Renders the media attached to a chat message — both user uploads and
 * agent-generated media. Images open a full-screen lightbox; audio and video
 * get native players; documents/links render as a card with a download/open
 * affordance. Used by the chat overlay bubble and `MessageContent`.
 */
export function MessageAttachments({
  attachments,
  className,
}: MessageAttachmentsProps): React.JSX.Element | null {
  const [lightbox, setLightbox] = React.useState<{
    src: string;
    alt: string;
    downloadAs: string;
  } | null>(null);
  const [transcript, setTranscript] = React.useState<MessageAttachment | null>(
    null,
  );

  if (!attachments || attachments.length === 0) return null;

  return (
    <div
      data-testid="message-attachments"
      className={cn("mt-1.5 flex flex-col gap-2", className)}
    >
      {attachments.map((att) => {
        const kind = resolveKind(att);
        // A transcript opens the maximized editor from the attachment record,
        // not by navigating to its URL — so it needs no URL guard.
        if (isTranscriptAttachment(att)) {
          return (
            <TranscriptTile
              key={att.id}
              att={att}
              onOpen={() => setTranscript(att)}
            />
          );
        }
        // Scheme allowlist: never hand an agent-provided URL with a dangerous
        // scheme (javascript:/vbscript:/file:/data:text/html/...) to the
        // browser as an href/src. Guard the RAW url before it is resolved.
        if (!isSafeAttachmentUrl(att.url)) {
          return <UnsafeAttachmentTile key={att.id} att={att} />;
        }
        const src = resolveAttachmentUrl(att.url);
        if (!src) return null;
        const label = attachmentLabel(att);
        switch (kind) {
          case "image": {
            // The thumbnail is a separate URL; only use it if it also passes
            // the scheme allowlist, otherwise fall back to the safe full src.
            const thumbSrc =
              att.thumbnailUrl && isSafeAttachmentUrl(att.thumbnailUrl)
                ? resolveAttachmentUrl(att.thumbnailUrl)
                : src;
            return (
              <ImageTile
                key={att.id}
                att={att}
                src={src}
                thumbSrc={thumbSrc || src}
                onExpand={() =>
                  setLightbox({
                    src,
                    alt: att.description?.trim() || label,
                    downloadAs: downloadName(att, "image"),
                  })
                }
              />
            );
          }
          case "audio":
            return (
              <div
                key={att.id}
                className="max-w-[min(22rem,100%)] rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5"
              >
                {att.title?.trim() ? (
                  <div className="mb-1.5 truncate text-[12px] font-medium text-white/80">
                    {att.title.trim()}
                  </div>
                ) : null}
                <audio src={src} controls preload="metadata" className="w-full">
                  <track kind="captions" />
                </audio>
              </div>
            );
          case "video":
            return (
              <video
                key={att.id}
                src={src}
                controls
                preload="metadata"
                // Reserve a stable 16:9 box so the row height is fixed before
                // the video metadata loads — avoids layout shift on load.
                className="aspect-video max-h-80 w-full max-w-[min(22rem,100%)] rounded-xl border border-white/12 object-contain"
              >
                <track kind="captions" />
              </video>
            );
          default:
            return <FileTile key={att.id} att={att} src={src} kind={kind} />;
        }
      })}
      {lightbox ? (
        <Lightbox
          src={lightbox.src}
          alt={lightbox.alt}
          downloadAs={lightbox.downloadAs}
          onClose={() => setLightbox(null)}
        />
      ) : null}
      {transcript ? (
        <TranscriptViewerOverlay
          attachment={transcript}
          onClose={() => setTranscript(null)}
        />
      ) : null}
    </div>
  );
}
