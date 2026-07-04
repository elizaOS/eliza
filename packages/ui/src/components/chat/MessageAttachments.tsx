/**
 * Renders the attachment previews under a chat message. `attachmentPreviewKind`
 * derives a fine-grained preview kind (image / audio / video / PDF inline vs
 * download-fallback / text-code / generic document) from mime + extension at
 * read time — the store keeps a frozen `ContentType`, so the kind is computed
 * here, not persisted (#8876). `resolveAttachmentUrl` normalises served
 * `/api/media/<hash>` paths against the active API base for the dev proxy, prod
 * same-origin, and desktop/native shells; every URL passes the scheme-allowlist
 * guard (`isSafeAttachmentUrl`) before rendering.
 *
 * See the "Files / attachments" note in this package's CLAUDE.md — don't add a
 * second attachment download path or URL guard; reuse the ones referenced here.
 */
import {
  Box,
  Code2,
  Download,
  ExternalLink,
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
import { useTranslation } from "../../state/TranslationContext.hooks";
import { resolveApiUrl } from "../../utils/asset-url";
import { isSafeAttachmentUrl } from "../../utils/attachment-url";
import { Button } from "../ui/button";
import { CodeBlock } from "../ui/code-block";
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

/**
 * A `data:` URL for a benign, non-executable inline text payload — the
 * `text/markdown` a large clipboard paste becomes (`pastedTextToAttachment`) or
 * a pasted/attached `.csv`. These are the user's OWN just-composed bytes,
 * echoed optimistically on their bubble until the server round-trip swaps in
 * the served URL.
 *
 * The scheme-allowlist guard {@link isSafeAttachmentUrl} exists to neutralise
 * hostile AGENT-provided URLs, and among `data:text/*` it allowlists only
 * `text/plain` — so a markdown/csv paste echo would otherwise fall through to
 * the "unsupported attachment" card, mis-rendering the user's own paste as
 * unsupported. A `data:text/markdown` / `data:text/csv` URL cannot execute
 * script: it is rendered as escaped text via CodeBlock, or handed to the
 * browser only as a download link, so it is safe to preview like any other text
 * attachment (this stays narrower than {@link isSafeAttachmentUrl} — notably it
 * never covers the script-capable `data:text/html`).
 */
const BENIGN_INLINE_TEXT_DATA_URL = /^data:text\/(?:markdown|csv)(?:[;,])/i;

function isBenignInlineTextDataUrl(url: string): boolean {
  return BENIGN_INLINE_TEXT_DATA_URL.test(url.trim());
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

/** A `.pdf` URL (ignoring any `?query` / `#hash`). */
const PDF_EXT = /\.pdf(?:[?#]|$)/i;

/**
 * Text/code extensions we can preview inline with {@link CodeBlock}, mapped to a
 * coarse language hint. Keep this list aligned with the regex used for kind
 * derivation; the hint is best-effort and only used for display.
 */
const CODE_EXT_LANGUAGE: Record<string, string> = {
  txt: "text",
  log: "text",
  text: "text",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  json: "json",
  jsonc: "json",
  json5: "json",
  csv: "csv",
  tsv: "csv",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  env: "ini",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
};

const CODE_EXT = new RegExp(
  `\\.(?:${Object.keys(CODE_EXT_LANGUAGE).join("|")})(?:[?#]|$)`,
  "i",
);

/**
 * Fine-grained preview kind, derived at read time from the attachment's
 * `contentType` + MIME + URL extension (and whether it carries extracted
 * `text`). `ContentType` is frozen, so this richer kind is computed here rather
 * than stored. Drives which tile renders:
 *   - `"pdf"`  → inline native PDF viewer (or a download card when not inlinable)
 *   - `"code"` → inline {@link CodeBlock} when `att.text` exists, else a card
 *   - `"file"` → generic download/open card (the previous default)
 */
export type AttachmentPreviewKind = "pdf" | "model3d" | "code" | "file";

/** glTF binary/text 3D model extensions. */
const MODEL3D_EXT = /\.(?:glb|gltf)(?:[?#]|$)/i;

/** The lower-cased path of an attachment URL (no query/hash), or "" for data: URLs. */
function attachmentPath(url: string): string {
  const u = url.trim().toLowerCase();
  if (!u || u.startsWith("data:")) return "";
  try {
    return new URL(u, "http://x").pathname;
  } catch {
    // Strip query/hash manually for malformed-but-extension-bearing strings.
    return u.split(/[?#]/)[0] ?? u;
  }
}

/**
 * Derive the inline-preview kind for a document/link attachment. Only called
 * once an attachment has resolved to a non-media kind (not image/audio/video);
 * media keeps its dedicated players. Pure + render-safe — inspects metadata
 * only, never fetches.
 */
export function attachmentPreviewKind(
  att: MessageAttachment,
): AttachmentPreviewKind {
  const mime = (att.mimeType ?? "").toLowerCase();
  const url = att.url ?? "";
  const path = attachmentPath(url);

  // PDF: explicit MIME, a .pdf URL, or a data:application/pdf payload.
  if (
    mime === "application/pdf" ||
    PDF_EXT.test(path) ||
    url.trim().toLowerCase().startsWith("data:application/pdf")
  ) {
    return "pdf";
  }

  // 3D model: a model/* MIME, a .glb/.gltf URL, or a data:model/* payload.
  // Checked before text/code so a .gltf (JSON) with extracted text still
  // previews as a model, not as code.
  if (
    mime.startsWith("model/") ||
    MODEL3D_EXT.test(path) ||
    url.trim().toLowerCase().startsWith("data:model/")
  ) {
    return "model3d";
  }

  // Text/code: a text-* MIME, a known code/text extension, an inline
  // text data: URL, or an attachment that already carries extracted text.
  if (
    mime.startsWith("text/") ||
    CODE_EXT.test(path) ||
    url.trim().toLowerCase().startsWith("data:text/") ||
    (typeof att.text === "string" && att.text.trim().length > 0)
  ) {
    return "code";
  }

  return "file";
}

/** Best-effort language hint for {@link CodeBlock}, from MIME then extension. */
function codeLanguageHint(att: MessageAttachment): string {
  const mime = (att.mimeType ?? "").toLowerCase();
  if (mime === "application/json" || mime === "text/json") return "json";
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/csv") return "csv";
  if (mime === "text/html") return "html";
  const path = attachmentPath(att.url ?? "");
  const ext = path.split(".").at(-1) ?? "";
  return CODE_EXT_LANGUAGE[ext] ?? "text";
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
          : kind === "pdf"
            ? "pdf"
            : kind === "code"
              ? "txt"
              : kind === "model3d"
                ? "glb"
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
    "bg-black/70 text-white/90 transition-colors",
    "hover:bg-black/85   ",
  );
  if (href) {
    return (
      <Button asChild variant="ghost" size="icon-sm" className={cls}>
        <a
          href={href}
          download={download}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          title={label}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </a>
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={cls}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {children}
    </Button>
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
      <Button
        variant="ghost"
        onClick={onExpand}
        className="block h-auto w-full cursor-zoom-in rounded-none bg-transparent p-0 hover:bg-transparent   "
        aria-label={`Expand image ${label}`}
      >
        <img
          src={thumbSrc}
          alt={att.description?.trim() || label}
          loading="lazy"
          // Reserve a stable box via aspect-ratio so the row height is fixed
          // before the image loads — avoids layout shift / scroll-anchor yank.
          // The type carries no intrinsic dimensions, so a 4:3 default is used.
          // `object-contain` letterboxes the full image inside that reserved box
          // (mirrors the video branch + lightbox) so non-4:3 content isn't cropped.
          className="block aspect-[4/3] max-h-80 w-full object-contain"
        />
      </Button>
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
    <Button
      asChild
      variant="ghost"
      className={cn(
        "h-auto max-w-[min(20rem,100%)] justify-start gap-2.5 whitespace-normal rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5",
        "text-white/90 transition-colors hover:bg-white/[0.12]   ",
      )}
    >
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        download={kind === "link" ? undefined : downloadName(att, kind)}
      >
        <Icon className="h-5 w-5 shrink-0 text-white/70" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">
            {label}
          </span>
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
    </Button>
  );
}

/**
 * Whether a (scheme-safe) URL can be inlined in an `<iframe>`. We only inline a
 * served same-origin / app URL (`/api/...`, http(s), blob:); a `data:` URL is
 * NOT inlined (browsers sandbox/refuse `data:` PDFs inconsistently and it can be
 * huge), so it falls back to a download-only card.
 */
function isInlineablePdfUrl(rawUrl: string): boolean {
  const u = rawUrl.trim().toLowerCase();
  if (!u) return false;
  if (u.startsWith("data:")) return false;
  return true;
}

/**
 * Inline PDF preview. When the served URL is inlinable, render the browser's
 * native PDF viewer inside a sandboxed `<iframe>` under a header with the
 * filename and an open/download affordance. For a `data:` URL (or otherwise
 * non-inlinable safe URL) it degrades to a download-only card — no iframe.
 */
function PdfTile({
  att,
  src,
  t,
}: {
  att: MessageAttachment;
  src: string;
  t: (key: string, values?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const label = attachmentLabel(att);
  const inlineable = isInlineablePdfUrl(att.url);
  const openLabel = t("messageattachments.openPdf");
  const downloadLabel = t("messageattachments.download");
  const frameTitle = t("messageattachments.pdfPreviewTitle", { name: label });

  if (!inlineable) {
    // data: / non-inlinable safe URL → download card, no iframe.
    return (
      <Button
        asChild
        variant="ghost"
        className={cn(
          "h-auto max-w-[min(20rem,100%)] justify-start gap-2.5 whitespace-normal rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5",
          "text-white/90 transition-colors hover:bg-white/[0.12]   ",
        )}
      >
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          download={downloadName(att, "pdf")}
          data-testid="pdf-attachment-fallback"
        >
          <FileText className="h-5 w-5 shrink-0 text-white/70" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">
              {label}
            </span>
            <span className="block text-[11px] uppercase tracking-wide text-white/45">
              {t("messageattachments.pdfLabel")}
            </span>
          </span>
          <Download className="h-4 w-4 shrink-0 text-white/55" />
        </a>
      </Button>
    );
  }

  return (
    <figure
      data-testid="pdf-attachment"
      aria-label={frameTitle}
      className="m-0 w-full max-w-[min(36rem,100%)] overflow-hidden rounded-xl border border-white/12 bg-white/[0.04]"
    >
      <figcaption className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-white/70" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/90">
          {label}
        </span>
        <span className="flex shrink-0 gap-1.5">
          <TileButton label={openLabel} href={src}>
            <ExternalLink className="h-3.5 w-3.5" />
          </TileButton>
          <TileButton
            label={downloadLabel}
            href={src}
            download={downloadName(att, "pdf")}
          >
            <Download className="h-3.5 w-3.5" />
          </TileButton>
        </span>
      </figcaption>
      <iframe
        src={src}
        title={frameTitle}
        // Sandbox the embedded document: allow it to be treated as same-origin
        // so the native viewer's resources load, but grant no script/forms/etc.
        sandbox="allow-same-origin"
        className="block h-[28rem] w-full border-0 bg-white"
      />
    </figure>
  );
}

/** Whether a (scheme-safe) model URL can be inlined in the WebGL viewer. */
function isInlineableModelUrl(rawUrl: string): boolean {
  const u = rawUrl.trim().toLowerCase();
  if (!u) return false;
  // data: URLs are not inlined (can be huge; keep parity with the PDF tile) —
  // they degrade to a download card.
  if (u.startsWith("data:")) return false;
  return true;
}

type Model3dStatus = "loading" | "ready" | "error" | "unsupported";

/**
 * Inline 3D model preview (#8876). For an inlinable, scheme-safe `.glb`/`.gltf`
 * URL, lazily loads three.js + GLTFLoader, auto-frames the model to its bounding
 * box, and renders it in an auto-rotating WebGL canvas. Every failure mode —
 * no WebGL (jsdom / headless without GL), a `data:` URL, a load/parse error —
 * degrades to the same download card, so the bytes are never walled off. three
 * is imported on demand so it never ships in the always-loaded chat bundle.
 */
function Model3dTile({
  att,
  src,
  t,
}: {
  att: MessageAttachment;
  src: string;
  t: (key: string, values?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const label = attachmentLabel(att);
  const inlineable = isInlineableModelUrl(att.url);
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = React.useState<Model3dStatus>(
    inlineable ? "loading" : "unsupported",
  );

  React.useEffect(() => {
    if (!inlineable) return;
    const mount = mountRef.current;
    if (!mount) return;

    // WebGL capability probe — bail to the download fallback when unavailable
    // (jsdom, headless without GL) rather than throwing.
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl") ?? null;
    if (!gl) {
      setStatus("unsupported");
      return;
    }

    let disposed = false;
    let frame = 0;
    let renderer: import("three").WebGLRenderer | null = null;

    (async () => {
      try {
        const THREE = await import("three");
        const { GLTFLoader } = await import(
          "three/addons/loaders/GLTFLoader.js"
        );
        if (disposed || !mountRef.current) return;
        const host = mountRef.current;
        const width = host.clientWidth || 320;
        const height = 288;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(
          45,
          width / height,
          0.1,
          1000,
        );
        const activeRenderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
        });
        renderer = activeRenderer;
        activeRenderer.setSize(width, height);
        activeRenderer.setPixelRatio(
          Math.min(globalThis.devicePixelRatio || 1, 2),
        );
        host.appendChild(activeRenderer.domElement);

        scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const key = new THREE.DirectionalLight(0xffffff, 1.1);
        key.position.set(3, 5, 4);
        scene.add(key);

        const gltf = await new GLTFLoader().loadAsync(src);
        if (disposed) {
          activeRenderer.dispose?.();
          return;
        }
        const model = gltf.scene;

        // Auto-frame: center the model and pull the camera back to fit it.
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        model.position.sub(center);
        const radius = Math.max(size.x, size.y, size.z, 0.001) / 2;
        const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
        camera.position.set(0, radius * 0.4, dist * 1.5);
        camera.lookAt(0, 0, 0);
        scene.add(model);

        const animate = () => {
          if (disposed) return;
          model.rotation.y += 0.01;
          activeRenderer.render(scene, camera);
          frame = requestAnimationFrame(animate);
        };
        setStatus("ready");
        animate();
      } catch {
        if (!disposed) setStatus("error");
      }
    })();

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      try {
        renderer?.domElement?.remove();
        renderer?.dispose?.();
      } catch {
        // best-effort teardown
      }
    };
  }, [inlineable, src]);

  const downloadLabel = t("messageattachments.download");
  const showFallbackBody = status === "unsupported" || status === "error";

  return (
    <figure
      data-testid="model3d-attachment"
      aria-label={label}
      className="m-0 w-full max-w-[min(28rem,100%)] overflow-hidden rounded-xl border border-white/12 bg-white/[0.04]"
    >
      <figcaption className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Box className="h-4 w-4 shrink-0 text-white/70" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/90">
          {label}
        </span>
        <span className="flex shrink-0 gap-1.5">
          <TileButton
            label={downloadLabel}
            href={src}
            download={downloadName(att, "model3d")}
          >
            <Download className="h-3.5 w-3.5" />
          </TileButton>
        </span>
      </figcaption>
      {showFallbackBody ? (
        <Button
          asChild
          variant="ghost"
          className="h-auto w-full justify-start gap-2.5 rounded-none px-3 py-3 text-white/85 transition-colors hover:bg-white/[0.08]"
        >
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            download={downloadName(att, "model3d")}
            data-testid="model3d-attachment-fallback"
          >
            <Box className="h-5 w-5 shrink-0 text-white/60" />
            <span className="min-w-0 flex-1 text-[12px] text-white/60">
              {t("messageattachments.model3dDownloadToView")}
            </span>
            <Download className="h-4 w-4 shrink-0 text-white/55" />
          </a>
        </Button>
      ) : (
        <div
          ref={mountRef}
          data-testid="model3d-canvas"
          className="relative h-72 w-full bg-black/40"
        >
          {status === "loading" ? (
            <span className="absolute inset-0 flex items-center justify-center text-[12px] text-white/60">
              {t("messageattachments.model3dLoading")}
            </span>
          ) : null}
        </div>
      )}
    </figure>
  );
}

/**
 * Inline text/code preview using the {@link CodeBlock} primitive. Renders the
 * attachment's extracted `att.text` (scrollable, capped height, with a copy
 * button) when present; otherwise degrades to a download/open card — v1 does
 * NOT fetch the URL.
 */
function CodeTile({
  att,
  src,
  t,
}: {
  att: MessageAttachment;
  src: string;
  t: (key: string, values?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const label = attachmentLabel(att);
  const text = typeof att.text === "string" ? att.text : "";

  if (!text.trim()) {
    // No inline content available → download/open card (no fetch in v1).
    return (
      <Button
        asChild
        variant="ghost"
        className={cn(
          "h-auto max-w-[min(20rem,100%)] justify-start gap-2.5 whitespace-normal rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5",
          "text-white/90 transition-colors hover:bg-white/[0.12]   ",
        )}
      >
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          download={downloadName(att, "code")}
          data-testid="code-attachment-fallback"
        >
          <Code2 className="h-5 w-5 shrink-0 text-white/70" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">
              {label}
            </span>
            <span className="block text-[11px] uppercase tracking-wide text-white/45">
              {t("messageattachments.textLabel")}
            </span>
          </span>
          <Download className="h-4 w-4 shrink-0 text-white/55" />
        </a>
      </Button>
    );
  }

  const language = codeLanguageHint(att);
  return (
    <figure
      data-testid="code-attachment"
      aria-label={t("messageattachments.codePreviewTitle", { name: label })}
      className="m-0 w-full max-w-[min(36rem,100%)] overflow-hidden rounded-xl border border-white/12 bg-white/[0.04]"
    >
      <figcaption className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Code2 className="h-4 w-4 shrink-0 text-white/70" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/90">
          {label}
        </span>
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-white/45">
          {language}
        </span>
        <TileButton
          label={t("messageattachments.download")}
          href={src}
          download={downloadName(att, "code")}
        >
          <Download className="h-3.5 w-3.5" />
        </TileButton>
      </figcaption>
      <CodeBlock
        value={text}
        copyable
        data-language={language}
        className="max-h-[24rem] overflow-auto rounded-none border-0 bg-transparent"
      />
    </figure>
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
    <Button
      variant="ghost"
      onClick={onOpen}
      data-testid="transcript-attachment"
      className={cn(
        "group h-auto max-w-[min(20rem,100%)] justify-start gap-2.5 whitespace-normal rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5 text-left",
        "text-white/90 transition-colors hover:bg-white/[0.12]   ",
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
    </Button>
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
      <Button
        variant="ghost"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute inset-0 h-auto w-auto cursor-zoom-out rounded-none bg-black/85 p-0 hover:bg-black/85"
      />
      <img
        src={src}
        alt={alt}
        // pointer-events fall through to the backdrop button, so clicking the
        // image closes too — standard lightbox behaviour.
        className="pointer-events-none relative max-h-full max-w-full rounded-lg object-contain"
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
 * get native players; PDFs render the browser's native viewer inline; text/code
 * render inline via {@link CodeBlock} when their content is available; other
 * documents/links render as a card with a download/open affordance. Used by the
 * chat overlay bubble and `MessageContent`.
 */
export function MessageAttachments({
  attachments,
  className,
}: MessageAttachmentsProps): React.JSX.Element | null {
  const { t } = useTranslation();
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
        // browser as an href/src. Guard the RAW url before it is resolved. A
        // benign inline text paste echo (data:text/markdown|csv — the user's
        // own just-composed content, not an agent URL) is not on the strict
        // scheme allowlist but is safe to preview, so it is not neutralized.
        if (
          !isSafeAttachmentUrl(att.url) &&
          !isBenignInlineTextDataUrl(att.url)
        ) {
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
                data-testid="audio-attachment"
                className="max-w-[min(22rem,100%)] rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5"
              >
                {att.title?.trim() ? (
                  <div className="mb-1.5 truncate text-[12px] font-medium text-white/80">
                    {att.title.trim()}
                  </div>
                ) : null}
                <audio
                  src={src}
                  controls
                  preload="metadata"
                  className="w-full"
                  data-testid="audio-attachment-player"
                >
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
          default: {
            // `document` attachments get a richer inline preview when we can
            // derive one: PDFs render the native viewer; text/code renders via
            // CodeBlock. Genuine `link` attachments and anything we cannot
            // preview keep the generic download/open card.
            if (kind === "document") {
              const previewKind = attachmentPreviewKind(att);
              if (previewKind === "pdf") {
                return <PdfTile key={att.id} att={att} src={src} t={t} />;
              }
              if (previewKind === "model3d") {
                return <Model3dTile key={att.id} att={att} src={src} t={t} />;
              }
              if (previewKind === "code") {
                return <CodeTile key={att.id} att={att} src={src} t={t} />;
              }
            }
            return <FileTile key={att.id} att={att} src={src} kind={kind} />;
          }
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
