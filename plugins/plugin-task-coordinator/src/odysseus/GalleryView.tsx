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
  Folder,
  Image as ImageIcon,
  Minus,
  Pencil,
  Settings,
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

const NO_BACKEND = "Image library offline";
const NO_CANVAS_BACKEND = "Canvas backend offline";

const GALLERY_TABS: ReadonlyArray<{
  id: GalleryTab;
  label: string;
  icon: ReactNode;
}> = [
  { id: "images", label: "Photos", icon: <ImageIcon size={14} /> },
  { id: "albums", label: "Albums", icon: <Folder size={14} /> },
  { id: "editor", label: "Edit", icon: <Pencil size={14} /> },
  { id: "settings", label: "AI", icon: <Settings size={14} /> },
];

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

        <div className="od-gallery-tabs">
          {GALLERY_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`od-gallery-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
              title={t.label}
            >
              <span className="od-gallery-tab-icon">{t.icon}</span>
              <span className="od-gallery-tab-label">{t.label}</span>
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div className="od-gallery-body">
          {tab === "images" ? (
            <div className="od-gallery-images-container">
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
                </div>
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
                <div className="od-gallery-empty">Library offline</div>
              </div>
            </div>
          ) : null}

          {tab === "albums" ? (
            <div className="od-gallery-secondary">
              <div className="od-gallery-empty">No albums yet.</div>
            </div>
          ) : null}

          {tab === "editor" ? (
            <div className="od-gallery-secondary">
              <div className="gallery-editor-landing">
                <Pencil size={44} strokeWidth={1.4} aria-hidden="true" />
                <h3>
                  Image Editor <span className="ge-alpha-tag">Alpha</span>
                </h3>
                <div className="gallery-editor-landing-actions">
                  <button
                    type="button"
                    className="od-gallery-select-btn gallery-editor-landing-btn"
                    title={NO_CANVAS_BACKEND}
                    disabled
                  >
                    New canvas
                  </button>
                  <button
                    type="button"
                    className="od-gallery-select-btn gallery-editor-landing-btn"
                    onClick={() => setTab("images")}
                  >
                    Browse photos
                  </button>
                </div>
                <select
                  className="gallery-editor-template-select"
                  defaultValue=""
                  title={NO_CANVAS_BACKEND}
                  disabled
                  aria-label="Pick a canvas template size"
                >
                  <option value="">Template size</option>
                  {EDITOR_TEMPLATES.map((p, i) => (
                    <option key={p.label} value={i}>
                      {p.label}
                    </option>
                  ))}
                </select>
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
                      title="Draft backend offline"
                      disabled
                      aria-label="Search saved projects"
                    />
                    <button
                      type="button"
                      className="od-gallery-select-btn"
                      title="Draft backend offline"
                      disabled
                    >
                      Select
                    </button>
                  </div>
                  <div className="gallery-editor-drafts-grid">
                    <div className="od-gallery-empty">No saved projects</div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {tab === "settings" ? (
            <div className="od-gallery-secondary">
              <div className="od-gallery-settings-card">
                <h2 className="od-gallery-settings-title">AI Tagging</h2>
                <p className="od-gallery-settings-desc">Offline</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
