// odysseus image gallery (static/js/gallery.js — the Photos tab: an upload +
// library tool). Odysseus's gallery is a photo BACKUP + LIBRARY surface whose
// every affordance — upload, albums, source filter, AI-tagging, the detail
// lightbox, favorite/download/delete — is server-backed via /api/gallery/*
// (library, upload, albums, PATCH/DELETE per image, audit/tagging). The grid
// also stores images generated elsewhere (chat), refreshed via a
// 'gallery-refresh' window event.
//
// elizaMapping: eliza exposes NO frontend-callable gallery client method —
// grepped the @elizaos/ui `client` singleton: there is no fetchGallery /
// uploadGallery / generateImage / album method, only model/media *config*
// types. With no gallery backend, none of odysseus's controls can be wired to
// real behaviour, so this is the faithful no-eliza-equivalent path: the Photos
// tab renders odysseus's exact honest empty state ("No photos yet. Click Upload
// or drag-and-drop to get started!"), and the Settings tab keeps odysseus's
// AI-Tagging explainer text. The Upload tile is rendered as a disabled
// affordance with an honest title, since no upload endpoint exists. No
// fabricated images, sources, prompts, albums, or progress are ever shown, and
// no interactive control is rendered that would route nowhere.

import { Image as ImageIcon, Upload, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

type GalleryTab = "images" | "albums" | "settings";

export function GalleryView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
  locale?: string;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-gallery", { w: 960, h: 820 });
  const [tab, setTab] = useState<GalleryTab>("images");

  if (!open) return null;

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
              {/* Grid: Upload tile + odysseus's exact empty caption. No image
                  library backend exists in eliza, so the grid stays empty and
                  the Upload tile is a disabled affordance (no upload endpoint
                  to route to) rather than a control that does nothing. */}
              <div className="od-gallery-grid od-gallery-grid-empty">
                <div
                  className="od-gallery-card od-gallery-card-upload od-gallery-card-disabled"
                  title="Upload is unavailable — no image library backend is connected yet"
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
              <div className="od-gallery-backend-note">
                Photo library isn’t wired to a backend yet — upload, albums, and
                AI tagging light up once an image library is connected.
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
        </div>
      </div>
    </div>
  );
}
