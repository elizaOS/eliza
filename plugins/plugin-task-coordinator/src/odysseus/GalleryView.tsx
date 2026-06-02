// odysseus image gallery (static/js/gallery.js — the Photos tab: grid + detail
// lightbox, plus a generation prompt bar). A responsive masonry-ish grid of
// generated/imported images, a per-image lightbox with prev/next navigation and
// a metadata sidebar, a search + source-filter + sort toolbar, and a bottom
// prompt bar to generate a new image. The galleryEditor / inpaint canvas (a
// separate ~160KB surface) is intentionally NOT ported — this is the gallery
// grid + lightbox + generate bar only.
//
// elizaMapping: odysseus's gallery is server-backed
// (GET /api/gallery/library + POST image generation). eliza exposes NO
// frontend-callable image-generation or gallery-library client method (grepped
// the @elizaos/ui `client` singleton — only model/media *config* types exist,
// no generateImage / fetchGallery method). So this is the faithful
// no-eliza-equivalent path: the grid renders odysseus's honest empty state
// ("No images yet — generate one above") and the generate bar is disabled with
// an inline notice until an image backend exists. The source-filter dropdown is
// populated from the REAL model list via client.fetchModels(provider) — the
// same /api/models endpoint CompareView uses — so the filter lights up with the
// agent's actual providers even though no images are stored yet. No fabricated
// images, prompts, or progress are ever shown.

import { client } from "@elizaos/ui";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Heart,
  Image as ImageIcon,
  MoreVertical,
  RotateCcw,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "../view-format";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

// Providers whose model lists feed the "All sources" filter dropdown — the same
// real /api/models fetch keys CompareView uses.
const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "xai",
  "ollama",
] as const;

type GalleryTab = "images" | "albums" | "settings";
type GallerySort = "shuffle" | "recent" | "oldest";

// A gallery image record (gallery.js library item shape, trimmed to the fields
// the grid + lightbox render). Kept typed so the grid lights up 1:1 the moment
// a real image backend populates it — but the default set is empty (honest
// empty state), never seeded with demo rows.
interface GalleryImage {
  id: string;
  url: string;
  filename: string;
  prompt: string;
  model: string;
  createdAt: number | null;
  width: number | null;
  height: number | null;
  favorite: boolean;
}

/** Card label: prefer the prompt, else a cleaned filename, else "Photo". */
function cardLabel(img: GalleryImage): string {
  const fromPrompt = img.prompt.trim();
  if (fromPrompt) return fromPrompt;
  const fromFile = img.filename
    .replace(/^\d{4,}[_-]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return fromFile || "Photo";
}

/** Narrow a raw <select> value to a GallerySort without an unsafe cast. */
function toSort(value: string): GallerySort {
  if (value === "shuffle" || value === "oldest") return value;
  return "recent";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.substring(0, max - 2)}...` : text;
}

function dimensions(img: GalleryImage): string {
  if (img.width && img.height) return `${img.width} x ${img.height}`;
  return "Unknown";
}

export function GalleryView({
  open,
  onClose,
  locale,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-gallery", { w: 960, h: 820 });
  const [tab, setTab] = useState<GalleryTab>("images");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [sort, setSort] = useState<GallerySort>("recent");
  const [selectMode, setSelectMode] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState("");

  // No eliza client method backs an image library (see file header) — the image
  // set is intentionally empty until a generation/library backend exists. Never
  // seeded with demo data.
  const images = useMemo<GalleryImage[]>(() => [], []);

  // Populate the "All sources" filter from the REAL provider model lists, the
  // same /api/models endpoint the settings + compare surfaces use. Failures are
  // non-fatal — the dropdown simply shows fewer sources.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all(
      PROVIDERS.map((provider) =>
        client
          .fetchModels(provider)
          .then((r): string[] => r.models.map((m) => m.name))
          .catch((): string[] => []),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const flat = lists.flat();
      setSources(Array.from(new Set(flat)).sort());
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const filtered = images.filter((img) => {
    if (sourceFilter && img.model !== sourceFilter) return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      img.prompt.toLowerCase().includes(q) ||
      img.filename.toLowerCase().includes(q)
    );
  });

  const detailImage =
    detailIndex !== null && detailIndex >= 0 && detailIndex < filtered.length
      ? filtered[detailIndex]
      : null;

  const openDetail = (idx: number) => {
    setDetailIndex(idx);
    setMenuOpen(false);
  };
  const closeDetail = () => {
    setDetailIndex(null);
    setMenuOpen(false);
  };
  const navDetail = (delta: number) => {
    if (detailIndex === null) return;
    const next = detailIndex + delta;
    if (next < 0 || next >= filtered.length) return;
    setDetailIndex(next);
    setMenuOpen(false);
  };

  const stats =
    images.length > 0 ? `${filtered.length} of ${images.length}` : "";

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Gallery"
    >
      <button
        type="button"
        aria-label="Close gallery"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-gallery-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Modal header (gallery.js modal-header) ── */}
        <div
          className="od-gallery-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <h4 className="od-gallery-title">
            <ImageIcon size={14} aria-hidden="true" />
            <span>Gallery</span>
            {stats ? <span className="od-gallery-stats">{stats}</span> : null}
          </h4>
          <button
            type="button"
            className="od-gallery-close"
            aria-label="Close gallery"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Tabs (gallery.js .gallery-tabs) — Edit tab omitted (separate surface) ── */}
        <div className="od-gallery-tabs">
          <button
            type="button"
            className={`od-gallery-tab${tab === "images" ? " active" : ""}`}
            onClick={() => setTab("images")}
          >
            <span className="od-gallery-tab-icon">
              <ImageIcon size={14} />
            </span>
            <span className="od-gallery-tab-label">Photos</span>
          </button>
          <button
            type="button"
            className={`od-gallery-tab${tab === "albums" ? " active" : ""}`}
            onClick={() => setTab("albums")}
          >
            <span className="od-gallery-tab-icon">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Albums"
              >
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </span>
            <span className="od-gallery-tab-label">Albums</span>
          </button>
          <button
            type="button"
            className={`od-gallery-tab${tab === "settings" ? " active" : ""}`}
            onClick={() => setTab("settings")}
          >
            <span className="od-gallery-tab-icon">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Settings"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </span>
            <span className="od-gallery-tab-label">Settings</span>
          </button>
        </div>

        {/* ── Body ── */}
        <div className="od-gallery-body">
          {tab === "images" ? (
            <div className="od-gallery-images-container">
              {/* Toolbar: search + source filter + sort + select */}
              <div className="od-gallery-toolbar">
                <div className="od-gallery-search-wrap">
                  <Search
                    size={13}
                    className="od-gallery-search-icon"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    className="od-gallery-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") onClose();
                    }}
                    placeholder="Search photos, tags…"
                    aria-label="Search photos"
                  />
                </div>
                <select
                  className="od-gallery-model-filter"
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  aria-label="Filter by source"
                >
                  <option value="">All sources</option>
                  {sources.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  className="od-gallery-sort"
                  value={sort}
                  onChange={(e) => setSort(toSort(e.target.value))}
                  aria-label="Sort photos"
                >
                  <option value="shuffle">Random</option>
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                </select>
                <button
                  type="button"
                  className={`od-gallery-select-btn${selectMode ? " active" : ""}`}
                  title="Select for bulk actions"
                  aria-pressed={selectMode}
                  onClick={() => setSelectMode((v) => !v)}
                >
                  Select
                </button>
              </div>

              {/* Grid: upload tile + cards, or honest empty state */}
              <div className="od-gallery-grid">
                <div
                  className="od-gallery-card od-gallery-card-upload"
                  title="Upload photos"
                >
                  <div className="od-gallery-card-upload-inner">
                    <Upload size={32} strokeWidth={1.5} />
                    <div className="od-gallery-card-upload-label">Upload</div>
                  </div>
                </div>
                {filtered.length === 0 ? (
                  <div className="od-gallery-empty">
                    No images yet — generate one above.
                  </div>
                ) : (
                  filtered.map((img, idx) => (
                    <button
                      type="button"
                      className="od-gallery-card"
                      key={img.id}
                      onClick={() => {
                        if (selectMode) return;
                        openDetail(idx);
                      }}
                    >
                      {selectMode ? (
                        <span className="od-gallery-select-dot" />
                      ) : null}
                      <span
                        className={`od-gallery-fav-btn${img.favorite ? " od-gallery-fav-active" : ""}`}
                        title="Favorite"
                      >
                        <Heart
                          size={14}
                          fill={img.favorite ? "currentColor" : "none"}
                        />
                      </span>
                      <span className="od-gallery-dl-btn" title="Download">
                        <Download size={14} />
                      </span>
                      <img
                        src={img.url}
                        alt={img.prompt}
                        loading="lazy"
                        className="od-gallery-card-img"
                      />
                      <div className="od-gallery-card-info">
                        <div className="od-gallery-card-prompt">
                          {truncate(cardLabel(img), 60)}
                        </div>
                        <div className="od-gallery-card-meta">
                          {img.model ? (
                            <span className="od-gallery-card-model">
                              {img.model}
                            </span>
                          ) : null}
                          <span className="od-gallery-card-date">
                            {img.createdAt
                              ? formatRelativeTime(img.createdAt, locale)
                              : ""}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>

              {/* ── Generate prompt bar (no eliza image backend → disabled) ── */}
              <div className="od-gallery-generate-bar">
                <Sparkles
                  size={15}
                  className="od-gallery-generate-icon"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  className="od-gallery-generate-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                  }}
                  placeholder="Describe an image to generate…"
                  aria-label="Image generation prompt"
                />
                <button
                  type="button"
                  className="od-gallery-generate-btn"
                  disabled
                  title="Image generation is not available — no image backend is connected yet"
                >
                  Generate
                </button>
              </div>
              <div className="od-gallery-generate-note">
                Image generation isn’t wired to a backend yet — this bar lights
                up once an image model is connected.
              </div>
            </div>
          ) : null}

          {tab === "albums" ? (
            <div className="od-gallery-secondary">
              <div className="od-gallery-empty">No albums yet.</div>
            </div>
          ) : null}

          {tab === "settings" ? (
            <div className="od-gallery-secondary">
              <div className="od-gallery-settings-card">
                <h2 className="od-gallery-settings-title">AI Tagging</h2>
                <p className="od-gallery-settings-desc">
                  Auto-tag photos by content with your vision model. Your own
                  tags are kept. Available once an image library is connected.
                </p>
              </div>
            </div>
          ) : null}

          {/* ── Detail lightbox (gallery.js _openDetail) ── */}
          {detailImage ? (
            <div className="od-gallery-detail">
              <div className="od-gallery-detail-header">
                <button
                  type="button"
                  className="od-gallery-detail-back"
                  onClick={closeDetail}
                >
                  ← Back
                </button>
                <div className="od-gallery-detail-spacer" />
                <button
                  type="button"
                  className={`od-gallery-detail-fav${detailImage.favorite ? " active" : ""}`}
                  title={detailImage.favorite ? "Unfavorite" : "Favorite"}
                  aria-label="Favorite"
                  aria-pressed={detailImage.favorite}
                >
                  <Heart
                    size={14}
                    fill={detailImage.favorite ? "currentColor" : "none"}
                  />
                </button>
                <div className="od-gallery-detail-menu-wrap">
                  <button
                    type="button"
                    className="od-gallery-detail-menu-btn"
                    title="Actions"
                    aria-label="Photo actions"
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <MoreVertical size={14} />
                  </button>
                  {menuOpen ? (
                    <div className="od-gallery-detail-menu" role="menu">
                      <button
                        type="button"
                        className="od-gallery-detail-menu-item"
                      >
                        <Heart size={12} />
                        {detailImage.favorite ? "Favorited" : "Favorite"}
                      </button>
                      <button
                        type="button"
                        className="od-gallery-detail-menu-item"
                      >
                        <Download size={12} />
                        Download
                      </button>
                      <button
                        type="button"
                        className="od-gallery-detail-menu-item od-gallery-detail-menu-danger"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="od-gallery-detail-body">
                <div className="od-gallery-detail-image">
                  <button
                    type="button"
                    className="od-gallery-detail-rotate od-gallery-detail-rotate-ccw"
                    title="Rotate counter-clockwise"
                    aria-label="Rotate left"
                  >
                    <RotateCcw size={18} />
                  </button>
                  <button
                    type="button"
                    className="od-gallery-detail-rotate od-gallery-detail-rotate-cw"
                    title="Rotate clockwise"
                    aria-label="Rotate right"
                  >
                    <RotateCw size={18} />
                  </button>
                  <button
                    type="button"
                    className={`od-gallery-detail-nav od-gallery-detail-nav-prev${detailIndex === 0 ? " od-gallery-detail-nav-disabled" : ""}`}
                    title="Previous"
                    aria-label="Previous"
                    onClick={() => navDetail(-1)}
                  >
                    <ChevronLeft size={24} />
                  </button>
                  <div className="od-gallery-detail-img-frame">
                    <img
                      src={detailImage.url}
                      alt={detailImage.prompt}
                      className="od-gallery-detail-img"
                    />
                  </div>
                  <button
                    type="button"
                    className={`od-gallery-detail-nav od-gallery-detail-nav-next${detailIndex === filtered.length - 1 ? " od-gallery-detail-nav-disabled" : ""}`}
                    title="Next"
                    aria-label="Next"
                    onClick={() => navDetail(1)}
                  >
                    <ChevronRight size={24} />
                  </button>
                </div>
                <div className="od-gallery-detail-sidebar">
                  <div className="od-gallery-detail-section">
                    <label htmlFor="od-gallery-name-input">Name</label>
                    <input
                      id="od-gallery-name-input"
                      type="text"
                      className="od-gallery-detail-name-input"
                      defaultValue={detailImage.prompt}
                      placeholder="Untitled photo"
                    />
                  </div>
                  {detailImage.prompt ? (
                    <div className="od-gallery-detail-section">
                      <span className="od-gallery-detail-label">Prompt</span>
                      <div className="od-gallery-detail-prompt">
                        {detailImage.prompt}
                      </div>
                    </div>
                  ) : null}
                  <div className="od-gallery-detail-section">
                    <span className="od-gallery-detail-label">Date</span>
                    <div>
                      {detailImage.createdAt
                        ? formatRelativeTime(detailImage.createdAt, locale)
                        : "Unknown"}
                    </div>
                  </div>
                  <div className="od-gallery-detail-section">
                    <span className="od-gallery-detail-label">Dimensions</span>
                    <div>{dimensions(detailImage)}</div>
                  </div>
                  {detailImage.model ? (
                    <div className="od-gallery-detail-section">
                      <span className="od-gallery-detail-label">Source</span>
                      <div>{detailImage.model}</div>
                    </div>
                  ) : null}
                  <div className="od-gallery-detail-section">
                    <label htmlFor="od-gallery-tag-input">Tags</label>
                    <input
                      id="od-gallery-tag-input"
                      type="text"
                      className="od-gallery-tag-input"
                      placeholder="Add a tag"
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
