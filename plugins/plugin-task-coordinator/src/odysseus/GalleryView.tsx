// odysseus image gallery (static/js/gallery.js — the Photos tab: an upload +
// library tool). Odysseus's gallery is a photo BACKUP + LIBRARY surface whose
// every affordance — upload, albums, source filter, sort, AI-tagging, the
// detail lightbox, favorite/download/delete — is server-backed via
// /api/gallery/* (library, upload, albums, PATCH/DELETE per image,
// audit/tagging). The grid also stores images generated elsewhere (chat),
// refreshed via a 'gallery-refresh' window event.
//
// elizaMapping: eliza exposes NO frontend-callable gallery client method —
// grepped the @elizaos/ui `client` singleton: there is no fetchGallery /
// uploadGallery / generateImage / album / favorite method. The only adjacent
// surface, MediaGalleryView, just SQL-scans the agent's message memory for
// media URLs (read-only detection) — it has no upload, albums, sources,
// favorites, sort, or AI-tagging. So none of odysseus's gallery controls can be
// wired to real behaviour, and this is the faithful no-eliza-equivalent path:
// the full Photos chrome (search + 'to tag' hint, source filter, sort, Select,
// the All / Favorites filter chips, the Upload tile) plus the Albums, Edit, and
// Settings tabs all render for exact 1:1 layout, but every control is
// INERT/disabled with an honest title explaining there is no image-library (or
// canvas) backend — no control routes nowhere, and no data is faked. The grid
// shows odysseus's exact empty state ("No photos yet. Click Upload or
// drag-and-drop to get started!") as the cell beside the Upload tile, and the
// Settings tab keeps odysseus's AI-Tagging explainer. No fabricated images,
// sources, prompts, albums, counts, or progress are ever shown.

import {
  CornerDownLeft,
  Image as ImageIcon,
  Minus,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

type GalleryTab = "images" | "albums" | "editor" | "settings";

// odysseus gallery.js _renderEditorLanding() template presets (lines 1070-1078)
// — the native <select> size list. Picking one would open the full editor at
// that canvas size; eliza has no frontend canvas/diffusion backend, so the
// select is rendered faithfully but inert (honest: no canvas backend).
const EDITOR_TEMPLATES: ReadonlyArray<{ w: number; h: number; label: string }> =
  [
    { w: 1024, h: 1024, label: "Square HD — 1024 × 1024" },
    { w: 1920, h: 1080, label: "Widescreen — 1920 × 1080" },
    { w: 1080, h: 1920, label: "Portrait — 1080 × 1920" },
    { w: 1080, h: 1080, label: "Instagram — 1080 × 1080" },
    { w: 1500, h: 1050, label: "Postcard — 1500 × 1050" },
    { w: 2480, h: 3508, label: "A4 (300dpi) — 2480 × 3508" },
    { w: 2550, h: 3300, label: "Letter (300dpi) — 2550 × 3300" },
    { w: 3840, h: 2160, label: "4K — 3840 × 2160" },
  ];

// Honest disabled reason for the Photos-tab controls (search, source filter,
// sort, Select, Upload, filter chips). eliza exposes no image-library backend,
// so none of these can do real work — they render 1:1 but stay inert.
const NO_BACKEND = "No image-library backend is connected yet";

// Honest disabled reason for the canvas-opening affordances (New canvas /
// template select). eliza exposes no frontend canvas/diffusion backend, so a
// blank canvas can't be created here; "Browse photos" stays real (it just
// switches to the Photos tab, same as odysseus).
const NO_CANVAS_BACKEND = "No image/canvas backend is connected yet";

export function GalleryView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls(
    "win-gallery",
    { w: 960, h: 820 },
    { label: "Gallery", icon: "Images", onClose },
  );
  const [tab, setTab] = useState<GalleryTab>("images");

  if (!open) return null;
  if (win.minimized) return null;

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
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
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
            {/* gallery.js #gallery-stats — dim 'N photos' count. No image
                library backend, so an honest 0. */}
            <span className="od-gallery-stats">0 photos</span>
          </h4>
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-gallery-close"
            aria-label="Close gallery"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* ── Tabs (gallery.js .gallery-tabs): Photos · Albums · Edit · Settings ── */}
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
          {/* Edit tab (gallery.js lines 1925-1929) — between Albums and
              Settings, pencil icon + 'Edit'. (The hidden close × that
              odysseus shows once a project is loaded needs an editor-drafts
              backend eliza lacks, so it is omitted in this empty state.) */}
          <button
            type="button"
            className={`od-gallery-tab${tab === "editor" ? " active" : ""}`}
            onClick={() => setTab("editor")}
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
                aria-label="Edit"
              >
                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </span>
            <span className="od-gallery-tab-label">Edit</span>
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
              {/* Toolbar (gallery.js .gallery-toolbar, lines 1945-1960):
                  search w/ 'to tag' enter-hint, source filter, sort, Select.
                  No gallery backend → every control inert/disabled with an
                  honest title, but the full row renders for 1:1 layout. */}
              <div className="od-gallery-toolbar">
                <div className="od-gallery-search-wrap">
                  <input
                    type="text"
                    className="od-gallery-search"
                    placeholder="Search photos, tags..."
                    disabled
                    title={NO_BACKEND}
                    aria-label="Search photos, tags"
                  />
                  {/* odysseus's '↵ to tag' hint — hidden until text is typed
                      (CSS :not(:placeholder-shown)); our input is disabled and
                      empty, so it stays hidden, matching the real frame. */}
                  <span
                    className="od-gallery-search-enter-hint"
                    aria-hidden="true"
                  >
                    <CornerDownLeft
                      size={13}
                      className="od-gallery-enter-key"
                    />
                    to tag
                  </span>
                </div>
                <span className="od-gallery-toolbar-break" aria-hidden="true" />
                <select
                  className="od-gallery-model-filter"
                  disabled
                  title={NO_BACKEND}
                  aria-label="Filter by source"
                  defaultValue=""
                >
                  <option value="">All sources</option>
                </select>
                <select
                  className="od-gallery-sort"
                  disabled
                  title={NO_BACKEND}
                  aria-label="Sort order"
                  defaultValue="shuffle"
                >
                  <option value="shuffle">Random</option>
                  <option value="recent">Recent</option>
                  <option value="oldest">Oldest</option>
                </select>
                <button
                  type="button"
                  className="od-gallery-select-btn od-gallery-toolbar-action"
                  disabled
                  title={`Select for bulk actions — ${NO_BACKEND}`}
                >
                  <span>Select</span>
                </button>
              </div>

              {/* Filter chips (gallery.js #gallery-filter-chips, _renderAlbums
                  lines 380-383): All (active) + heart Favorites. Inert — there
                  is nothing to filter, but the row renders for 1:1 chrome. */}
              <div className="od-gallery-filter-chips od-gallery-album-chips">
                <button
                  type="button"
                  className="od-gallery-chip active"
                  disabled
                  title={NO_BACKEND}
                >
                  All
                </button>
                <button
                  type="button"
                  className="od-gallery-chip od-gallery-chip-fav"
                  disabled
                  title={`Favorites — ${NO_BACKEND}`}
                  aria-label="Favorites"
                >
                  &#9829;
                </button>
              </div>

              {/* Grid: Upload tile + odysseus's exact empty caption as the cell
                  beside it (gallery.js _renderGrid empty branch: uploadTile +
                  the empty caption in the same grid). No upload endpoint exists,
                  so the tile is a disabled affordance rather than a control that
                  routes nowhere. */}
              <div className="od-gallery-grid od-gallery-grid-empty">
                <div
                  className="od-gallery-card od-gallery-card-upload od-gallery-card-disabled"
                  title={`Upload photos or videos — ${NO_BACKEND}`}
                  aria-disabled="true"
                >
                  <div className="od-gallery-card-upload-inner">
                    <Upload size={32} strokeWidth={1.5} />
                    <div className="od-gallery-card-upload-label">Upload</div>
                  </div>
                </div>
                <div className="od-gallery-empty">
                  No photos yet. Click Upload or drag-and-drop to get started!
                </div>
              </div>
            </div>
          ) : null}

          {tab === "albums" ? (
            <div className="od-gallery-secondary">
              <div className="od-gallery-empty">No albums yet.</div>
            </div>
          ) : null}

          {/* ── Edit tab landing (gallery.js _renderEditorLanding, lines
              1083-1112). Pen-tool glyph + 'Image Editor' Alpha heading,
              'New canvas...'/'Browse photos' actions, template select, and the
              Saved-projects row. eliza has no canvas/editor-drafts backend, so
              canvas-creating controls are honestly inert and the saved-projects
              grid shows its empty state — but every control is present 1:1. ── */}
          {tab === "editor" ? (
            <div className="od-gallery-secondary">
              <div className="gallery-editor-landing">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ opacity: 0.6 }}
                  role="img"
                  aria-label="Image editor"
                >
                  <path d="M12 19l7-7 3 3-7 7-3-3z" />
                  <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                  <path d="M2 2l7.586 7.586" />
                  <circle cx="11" cy="11" r="2" />
                </svg>
                <h3>
                  Image Editor <span className="ge-alpha-tag">Alpha</span>
                </h3>
                <p>
                  Start a blank canvas, or open a photo from your gallery to
                  edit it.
                </p>
                <div className="gallery-editor-landing-actions">
                  <button
                    type="button"
                    className="od-gallery-select-btn gallery-editor-landing-btn"
                    title={NO_CANVAS_BACKEND}
                    disabled
                  >
                    New canvas...
                  </button>
                  <button
                    type="button"
                    className="od-gallery-select-btn gallery-editor-landing-btn"
                    onClick={() => setTab("images")}
                  >
                    Browse photos
                  </button>
                </div>
                <label className="gallery-editor-template-label">
                  Or pick a template
                  <select
                    className="gallery-editor-template-select"
                    defaultValue=""
                    title={NO_CANVAS_BACKEND}
                    disabled
                    aria-label="Pick a canvas template size"
                  >
                    <option value="">Select a size…</option>
                    {EDITOR_TEMPLATES.map((p, i) => (
                      <option key={p.label} value={i}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="gallery-editor-drafts">
                  <div className="gallery-editor-drafts-header">
                    <h4 className="gallery-editor-drafts-title">
                      Saved projects
                    </h4>
                    <input
                      type="search"
                      className="gallery-editor-drafts-search"
                      placeholder="Search projects…"
                      autoComplete="off"
                      title="Saved projects need an editor-drafts backend, which isn’t connected yet"
                      disabled
                      aria-label="Search saved projects"
                    />
                    <button
                      type="button"
                      className="od-gallery-select-btn"
                      title="Saved projects need an editor-drafts backend, which isn’t connected yet"
                      disabled
                    >
                      Select
                    </button>
                  </div>
                  <div className="gallery-editor-drafts-grid">
                    <div className="od-gallery-empty">
                      No saved projects yet.
                    </div>
                  </div>
                </div>
              </div>
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
        </div>
      </div>
    </div>
  );
}
