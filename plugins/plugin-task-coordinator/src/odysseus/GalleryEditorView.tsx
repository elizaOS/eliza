// odysseus Gallery Editor (static/js/galleryEditor.js + the whole editor/
// subdir). A canvas image editor: a top toolbar (undo/redo/history, zoom group,
// Image + Filter menus, Shortcuts, Import, Save), a left tool palette (Move /
// Crop / Transform / Brush / Eraser / Clone / Lasso / Wand / Inpaint / Bg
// Remove / Sharpen), a central canvas stage with a checkerboard transparency
// backdrop, a right panel of per-tool option sliders + a LAYERS list, a
// floating HISTORY popover, and a keyboard-shortcuts cheatsheet. The full
// editor CHROME is cloned pixel-exact from odysseus's build/toolbar.js,
// build/topbar.js, build/controls.js, build/right-panel.js, build/popups.js,
// layer-panel.js, and history-panel.js.
//
// elizaMapping: odysseus's editor is server-backed — the canvas drawing engine,
// undo stack, layer compositor, and the AI tools (inpaint / outpaint / remove /
// bg-remove / sharpen / harmonize / style) all live behind a Python image
// backend (POST a flattened PNG → get a result layer). eliza exposes NO
// frontend-callable image / canvas / diffusion backend (grepped the @elizaos/ui
// `client` singleton — only model *config* fetch exists). So this is the honest
// no-eliza-equivalent path: every control is present and pixel-exact so the
// editor lights up 1:1 the moment a canvas backend exists, but the central
// stage renders odysseus's faithful empty "load or generate an image to edit"
// affordance instead of a fabricated canvas, the layer list is empty (no demo
// layers), the history popover shows only the genuine "Current" marker, and the
// AI / inpaint model dropdowns are populated from the REAL provider model lists
// via client.fetchModels(provider) — the same /api/models endpoint the gallery
// + compare + settings surfaces use. No fabricated canvas pixels, layers, undo
// states, or AI results are ever shown.

import { client } from "@elizaos/ui";
import {
  Eraser,
  Image as ImageIcon,
  Paintbrush,
  Redo2,
  RotateCcw,
  Sparkles,
  Undo2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";

// Providers whose model lists feed the AI / inpaint model dropdowns — the same
// real /api/models fetch keys CompareView + GalleryView use.
const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "xai",
  "ollama",
] as const;

// Honest disabled-control tooltip. eliza exposes no frontend image / canvas /
// diffusion backend, so every control that would mutate pixels (menu actions,
// AI buttons, selection-edit buttons) is disabled with this shared title
// instead of rendering an enabled control that routes nowhere.
const NO_BACKEND = "No image backend is connected yet";

// odysseus editor/build/toolbar.js `tools` — the left tool palette, including
// the AI-tools (✦) flag and the keyboard hint. `sep` rows render a labeled
// separator (the label is blank in odysseus but the separator rule stays).
type ToolId =
  | "move"
  | "crop"
  | "transform"
  | "brush"
  | "eraser"
  | "clone"
  | "lasso"
  | "wand"
  | "inpaint"
  | "rembg"
  | "sharpen";

interface ToolDef {
  id: ToolId;
  label: string;
  key?: string;
  ai?: boolean;
}

interface SepDef {
  sep: true;
}

const TOOLS: ReadonlyArray<ToolDef | SepDef> = [
  { id: "move", label: "Move", key: "V" },
  { id: "crop", label: "Crop", key: "C" },
  { id: "transform", label: "Transform", key: "T" },
  { sep: true },
  { id: "brush", label: "Brush", key: "B" },
  { id: "eraser", label: "Eraser", key: "E" },
  { sep: true },
  { id: "clone", label: "Clone", key: "K" },
  { id: "lasso", label: "Lasso", key: "L" },
  { id: "wand", label: "Wand", key: "W" },
  { sep: true },
  { id: "inpaint", label: "Inpaint", key: "M", ai: true },
  { id: "rembg", label: "Bg Remove", ai: true },
  { id: "sharpen", label: "Sharpen", key: "S", ai: true },
];

function isSep(t: ToolDef | SepDef): t is SepDef {
  return "sep" in t;
}

// odysseus toolbar.js per-tool icon SVGs — Move/Crop/Transform/Lasso are
// unicode glyphs; the rest are lucide-react icons matching odysseus's inline
// SVG paths (Brush ↔ Paintbrush, Eraser, Clone ↔ stamp, Wand, Inpaint ↔
// Paintbrush, Bg Remove ↔ scissors glyph, Sharpen ↔ ◈ glyph).
function ToolIcon({ id }: { id: ToolId }): ReactNode {
  if (id === "move") return <span className="ge-tool-glyph">✥</span>;
  if (id === "crop") return <span className="ge-tool-glyph">✂</span>;
  if (id === "transform") return <span className="ge-tool-glyph">⤢</span>;
  if (id === "lasso") return <span className="ge-tool-glyph">⟡</span>;
  if (id === "rembg") return <span className="ge-tool-glyph">✄</span>;
  if (id === "sharpen") return <span className="ge-tool-glyph">◈</span>;
  if (id === "brush" || id === "inpaint") return <Paintbrush size={18} />;
  if (id === "eraser") return <Eraser size={18} />;
  if (id === "wand") return <Wand2 size={18} />;
  // clone
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Clone"
    >
      <circle cx="12" cy="9" r="3" />
      <path d="M9 12l-3 4h12l-3-4" />
      <path d="M4 20h16" />
    </svg>
  );
}

// Log-scale brush slider position (controls.js: log(size)/log(800)*1000).
function brushSliderValue(size: number): number {
  return Math.round((Math.log(Math.max(1, size)) / Math.log(800)) * 1000);
}

// Selection-action button icons — match odysseus controls.js inline SVGs for
// the Lasso / Wand action rows (invert ↔ swap arrows, delete ↔ X, erase ↔
// trash, copy ↔ overlapping rects, mask ↔ wand). 12×12 to sit in .ge-btn-sm.
type SelectionIconKind = "invert" | "delete" | "erase" | "copy" | "mask";

function SelectionIcon({ kind }: { kind: SelectionIconKind }): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={kind}
    >
      {kind === "invert" ? (
        <>
          <polyline points="17 1 21 5 17 9" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <polyline points="7 23 3 19 7 15" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </>
      ) : null}
      {kind === "delete" ? (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      ) : null}
      {kind === "erase" ? (
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      ) : null}
      {kind === "copy" ? (
        <>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      ) : null}
      {kind === "mask" ? (
        <>
          <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
          <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
        </>
      ) : null}
    </svg>
  );
}

// A stroke-modifier slider row (Opacity / Flow / Softness) — shared by the
// Brush / Eraser / Clone sections (controls.js .ge-eraser-row). Read-only here
// (no canvas engine to drive), matching odysseus's default values.
function StrokeRow({
  previewId,
  label,
  value,
  min,
  max,
}: {
  previewId: string;
  label: string;
  value: number;
  min: number;
  max: number;
}): ReactNode {
  const sliderId = `${previewId}-slider`;
  return (
    <div className="ge-control-row ge-eraser-row">
      <span className="ge-eraser-preview" id={previewId} aria-hidden="true" />
      <label htmlFor={sliderId}>{label}</label>
      <input
        id={sliderId}
        type="range"
        min={min}
        max={max}
        value={value}
        readOnly
      />
      <span className="ge-slider-value">{value}%</span>
    </div>
  );
}

export function GalleryEditorView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-editor", { w: 1280, h: 900 });
  const [tool, setTool] = useState<ToolId>("move");
  const [models, setModels] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [imageMenuOpen, setImageMenuOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [inpaintMode, setInpaintMode] = useState<"paint" | "erase">("paint");
  const [wandMode, setWandMode] = useState<"replace" | "add" | "subtract">(
    "replace",
  );

  // Populate the AI / inpaint model dropdowns from the REAL provider model
  // lists (same /api/models endpoint the other surfaces use). Failures are
  // non-fatal — the dropdown simply shows fewer models.
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
      setModels(Array.from(new Set(lists.flat())).sort());
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  // Which per-tool section the right panel shows (galleryEditor.js tool-switch).
  const showBrushControls =
    tool === "brush" || tool === "eraser" || tool === "clone";
  const showColorRow = tool === "brush";

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Gallery editor"
    >
      <button
        type="button"
        aria-label="Close editor"
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
      <div className="od-search-panel od-ge-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div className="gallery-editor">
          {/* ── Top bar (editor/build/topbar.js buildTopbar) ── */}
          <div
            className="ge-topbar od-window-header"
            onPointerDown={win.onDragStart}
          >
            <div className="ge-topbar-left">
              <span
                className="ge-alpha-badge"
                title="This editor is in active development — expect rough edges"
              >
                ALPHA
              </span>
              <button
                type="button"
                className="ge-btn ge-btn-sm ge-stacked-btn"
                title="Undo"
                disabled
              >
                <span className="ge-stacked-glyph">
                  <Undo2 size={14} />
                </span>
                <span className="ge-stacked-label">UNDO</span>
              </button>
              <button
                type="button"
                className="ge-btn ge-btn-sm ge-stacked-btn"
                title="Redo"
                disabled
              >
                <span className="ge-stacked-glyph">
                  <Redo2 size={14} />
                </span>
                <span className="ge-stacked-label">REDO</span>
              </button>
              <button
                type="button"
                className="ge-btn ge-btn-sm ge-stacked-btn"
                title="History — click an entry to jump to that state"
                aria-label="History"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <span className="ge-stacked-glyph">
                  <RotateCcw size={14} />
                </span>
                <span className="ge-stacked-label">HISTORY</span>
              </button>
              <span className="ge-topbar-sep" />
              <button
                type="button"
                className="ge-btn ge-btn-sm"
                title={NO_BACKEND}
                aria-label="Zoom out"
                disabled
              >
                −
              </button>
              <span className="ge-zoom-stack">
                <span className="ge-zoom-glyph">
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
                    aria-label="Zoom"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
                <span className="ge-zoom-label">100%</span>
              </span>
              <button
                type="button"
                className="ge-btn ge-btn-sm"
                title={NO_BACKEND}
                aria-label="Zoom in"
                disabled
              >
                +
              </button>
              <span className="ge-topbar-sep" />
              <button
                type="button"
                className="ge-btn ge-btn-sm ge-stacked-btn"
                title={NO_BACKEND}
                aria-label="Fit to view"
                disabled
              >
                <span className="ge-stacked-glyph">
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
                    aria-label="Fit"
                  >
                    <polyline points="4 14 4 20 10 20" />
                    <polyline points="20 10 20 4 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </span>
                <span className="ge-stacked-label">FIT</span>
              </button>
              <button
                type="button"
                className="ge-btn ge-btn-sm ge-stacked-btn"
                title={NO_BACKEND}
                aria-label="Actual size"
                disabled
              >
                <span className="ge-stacked-glyph">1:1</span>
                <span className="ge-stacked-label">SCALE</span>
              </button>
              <span className="ge-topbar-sep" />
            </div>
            <div className="ge-topbar-right">
              <div className="ge-image-wrap">
                <button
                  type="button"
                  className="ge-btn ge-btn-sm"
                  title="Image actions"
                  aria-haspopup="true"
                  onClick={() => {
                    setImageMenuOpen((v) => !v);
                    setFilterMenuOpen(false);
                    setSaveMenuOpen(false);
                  }}
                >
                  Image ▾
                </button>
                {imageMenuOpen ? (
                  <div className="ge-image-menu dropdown" role="menu">
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span className="dropdown-icon">⤢</span>
                      <span>Canvas…</span>
                    </button>
                    <div className="ge-filter-submenu-label">Transform</div>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span className="dropdown-icon">↻</span>
                      <span>Rotate 90° CW</span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span className="dropdown-icon">↺</span>
                      <span>Rotate 180°</span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span className="dropdown-icon">⇆</span>
                      <span>Flip horizontal</span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span className="dropdown-icon">⇅</span>
                      <span>Flip vertical</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="ge-filter-wrap">
                <button
                  type="button"
                  className="ge-btn ge-btn-sm"
                  title="Filters"
                  aria-haspopup="true"
                  onClick={() => {
                    setFilterMenuOpen((v) => !v);
                    setImageMenuOpen(false);
                    setSaveMenuOpen(false);
                  }}
                >
                  Filter ▾
                </button>
                {filterMenuOpen ? (
                  <div className="ge-filter-menu dropdown" role="menu">
                    <div className="ge-filter-submenu-label">Blur</div>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span className="dropdown-icon">◍</span>
                      <span>Gaussian Blur…</span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span className="dropdown-icon">◎</span>
                      <span>Zoom Blur…</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <span className="ge-topbar-sep" />
              <button
                type="button"
                className="ge-btn ge-btn-sm"
                title="Keyboard shortcuts (?)"
                aria-label="Shortcuts"
                onClick={() => setShortcutsOpen((v) => !v)}
              >
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
                  aria-label="Shortcuts"
                >
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
                </svg>
              </button>
              <button
                type="button"
                className="ge-btn ge-btn-sm"
                title={NO_BACKEND}
                aria-label="Import image as layer"
                disabled
              >
                + Import
              </button>
              <div className="ge-save-wrap">
                <button
                  type="button"
                  className="ge-btn ge-btn-primary ge-save-menu-btn"
                  title="Save options"
                  onClick={() => {
                    setSaveMenuOpen((v) => !v);
                    setImageMenuOpen(false);
                    setFilterMenuOpen(false);
                  }}
                >
                  Save
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    role="img"
                    aria-label="Save options"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {saveMenuOpen ? (
                  <div className="ge-save-menu dropdown" role="menu">
                    <div className="dropdown-section-label">Image</div>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span>Save over original</span>
                      <span className="dropdown-shortcut">Ctrl+S</span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span>Save as copy</span>
                      <span className="dropdown-shortcut">Ctrl+Shift+S</span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span>Download PNG</span>
                    </button>
                    <div className="dropdown-section-divider" />
                    <div className="dropdown-section-label">Project</div>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span>Save project (.json)</span>
                    </button>
                    <button
                      type="button"
                      className="dropdown-item-compact"
                      disabled
                      title={NO_BACKEND}
                    >
                      <span>Load project…</span>
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="ge-ge-close"
                aria-label="Close editor"
                title="Close editor"
                onClick={onClose}
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* ── Editor body (toolbar + canvas + right panel) ── */}
          <div className="ge-editor-body">
            {/* Left tool palette (editor/build/toolbar.js) */}
            <div className="ge-toolbar">
              {TOOLS.map((t, i) =>
                isSep(t) ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: separators carry no id and never reorder.
                  <div className="ge-tool-sep" key={`sep-${i}`} />
                ) : (
                  <button
                    type="button"
                    key={t.id}
                    className={`ge-tool-btn${t.id === tool ? " active" : ""}${t.ai ? " is-ai" : ""}`}
                    title={t.label + (t.key ? ` (${t.key})` : "")}
                    onClick={() => setTool(t.id)}
                  >
                    {t.ai ? (
                      <span className="ge-tool-ai" title="AI">
                        ✦
                      </span>
                    ) : null}
                    <span className="ge-tool-icon">
                      <ToolIcon id={t.id} />
                    </span>
                    <span className="ge-tool-label">{t.label}</span>
                  </button>
                ),
              )}
            </div>

            {/* Canvas area (center) — honest empty stage. No canvas backend in
                eliza, so render the checkerboard stage with odysseus's
                "load / generate an image to edit" landing instead of a
                fabricated canvas. */}
            <div className="ge-canvas-area">
              <div className="gallery-editor-landing">
                <ImageIcon size={40} strokeWidth={1.25} aria-hidden="true" />
                <h3>
                  Image editor <span className="ge-alpha-tag">Alpha</span>
                </h3>
                <p>
                  Load an image from the gallery or generate one to start
                  editing. The canvas, layers, and AI tools light up once an
                  image backend is connected.
                </p>
                <div className="gallery-editor-landing-actions">
                  <button
                    type="button"
                    className="ge-btn ge-ge-landing-btn"
                    disabled
                    title={NO_BACKEND}
                  >
                    <Upload size={14} />
                    Import image
                  </button>
                  <button
                    type="button"
                    className="ge-btn ge-ge-landing-btn"
                    disabled
                    title={NO_BACKEND}
                  >
                    <Sparkles size={14} />
                    Generate image
                  </button>
                </div>
              </div>
            </div>

            {/* Right panel (controls + layers) — editor/build/right-panel.js */}
            <div className="ge-right-panel">
              <div className="ge-controls">
                {/* Brush controls — Color + Size (controls.js #ge-brush-controls) */}
                {showBrushControls ? (
                  <div className="ge-brush-controls">
                    {showColorRow ? (
                      <div className="ge-control-row ge-color-row">
                        <label htmlFor="ge-color-picker">Color</label>
                        <input
                          id="ge-color-picker"
                          type="color"
                          className="ge-color-picker"
                          value="#ff3b3b"
                          readOnly
                        />
                      </div>
                    ) : null}
                    <div className="ge-control-row">
                      <label htmlFor="ge-size-slider">
                        {tool === "eraser" ? "Brush Size " : "Size "}
                        <span className="ge-size-label">12px</span>
                      </label>
                      <input
                        id="ge-size-slider"
                        type="range"
                        className="ge-size-slider"
                        min={0}
                        max={1000}
                        value={brushSliderValue(12)}
                        readOnly
                      />
                    </div>
                  </div>
                ) : null}

                {/* Brush section (Opacity / Flow / Softness) */}
                {tool === "brush" ? (
                  <div className="ge-eraser-section">
                    <div className="ge-section-title">Brush</div>
                    <StrokeRow
                      previewId="ge-brush-preview-opacity"
                      label="Opacity"
                      value={100}
                      min={10}
                      max={100}
                    />
                    <StrokeRow
                      previewId="ge-brush-preview-flow"
                      label="Flow"
                      value={100}
                      min={5}
                      max={100}
                    />
                    <StrokeRow
                      previewId="ge-brush-preview-softness"
                      label="Softness"
                      value={100}
                      min={0}
                      max={300}
                    />
                  </div>
                ) : null}

                {/* Eraser section */}
                {tool === "eraser" ? (
                  <div className="ge-eraser-section">
                    <div className="ge-section-title">Eraser</div>
                    <StrokeRow
                      previewId="ge-eraser-preview-opacity"
                      label="Opacity"
                      value={100}
                      min={10}
                      max={100}
                    />
                    <StrokeRow
                      previewId="ge-eraser-preview-flow"
                      label="Flow"
                      value={100}
                      min={5}
                      max={100}
                    />
                    <StrokeRow
                      previewId="ge-eraser-preview-softness"
                      label="Softness"
                      value={100}
                      min={0}
                      max={300}
                    />
                  </div>
                ) : null}

                {/* Clone section */}
                {tool === "clone" ? (
                  <div className="ge-eraser-section">
                    <div className="ge-section-title ge-section-title-with-help">
                      <span>Clone</span>
                      <span
                        className="ge-section-help"
                        role="img"
                        aria-label="How clone works"
                        title="Alt-click somewhere on the canvas to set the sample source, then drag elsewhere to clone those pixels onto the active layer."
                      >
                        ?
                      </span>
                    </div>
                    <p className="ge-section-hint">
                      <strong>Alt-click</strong> to set source · drag to paint
                    </p>
                    <StrokeRow
                      previewId="ge-clone-preview-opacity"
                      label="Opacity"
                      value={100}
                      min={10}
                      max={100}
                    />
                    <StrokeRow
                      previewId="ge-clone-preview-flow"
                      label="Flow"
                      value={100}
                      min={5}
                      max={100}
                    />
                    <StrokeRow
                      previewId="ge-clone-preview-softness"
                      label="Softness"
                      value={100}
                      min={0}
                      max={300}
                    />
                  </div>
                ) : null}

                {/* Lasso section (controls.js #ge-lasso-section). The
                    selection-edit actions operate on a live mask, so without a
                    canvas backend they are honestly disabled. */}
                {tool === "lasso" ? (
                  <div className="ge-lasso-section">
                    <div className="ge-control-row ge-actions ge-ge-actions-wrap">
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="invert" />
                        Invert
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="delete" />
                        Delete
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="copy" />
                        Copy Layer
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="mask" />
                        To Mask
                      </button>
                    </div>
                    <p className="ge-ge-tiny-hint">
                      Draw a freehand selection. Esc to cancel.
                    </p>
                  </div>
                ) : null}

                {/* Wand section */}
                {tool === "wand" ? (
                  <div className="ge-wand-section">
                    <div className="ge-control-row ge-ge-mode-row">
                      <button
                        type="button"
                        className={`ge-btn ge-btn-sm ge-wand-mode-btn${wandMode === "replace" ? " active" : ""}`}
                        title="Replace selection on each click"
                        onClick={() => setWandMode("replace")}
                      >
                        New
                      </button>
                      <button
                        type="button"
                        className={`ge-btn ge-btn-sm ge-wand-mode-btn${wandMode === "add" ? " active" : ""}`}
                        title="Add to selection (Shift)"
                        onClick={() => setWandMode("add")}
                      >
                        + Add
                      </button>
                      <button
                        type="button"
                        className={`ge-btn ge-btn-sm ge-wand-mode-btn${wandMode === "subtract" ? " active" : ""}`}
                        title="Subtract from selection (Alt)"
                        onClick={() => setWandMode("subtract")}
                      >
                        − Subtract
                      </button>
                    </div>
                    <div className="ge-control-row ge-eraser-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-wand-tol-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-wand-tolerance">
                        Tolerance <span className="ge-slider-value">32</span>
                      </label>
                      {/* Live retune toggle — re-runs the flood fill while the
                          tolerance slider drags. Needs an active selection, so
                          honestly disabled without a canvas backend. */}
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-wand-live-btn"
                        title={NO_BACKEND}
                        aria-pressed="false"
                        disabled
                      >
                        Live
                      </button>
                      <input
                        id="ge-wand-tolerance"
                        type="range"
                        min={0}
                        max={100}
                        value={32}
                        readOnly
                      />
                    </div>
                    {/* Selection-edge refine rows (controls.js #ge-wand-refine-*).
                        They retune an existing selection's mask alpha, so without
                        a canvas backend they sit in their honest disabled state. */}
                    <div className="ge-control-row ge-eraser-row ge-sel-refine">
                      <span
                        className="ge-eraser-preview"
                        id="ge-wand-feather-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-wand-feather">
                        Feather <span className="ge-slider-value">0px</span>
                      </label>
                      <input
                        id="ge-wand-feather"
                        type="range"
                        min={0}
                        max={200}
                        value={0}
                        title={NO_BACKEND}
                        disabled
                      />
                    </div>
                    <div className="ge-control-row ge-eraser-row ge-sel-refine">
                      <span
                        className="ge-eraser-preview"
                        id="ge-wand-grow-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-wand-grow">
                        Edge stroke <span className="ge-slider-value">0px</span>
                      </label>
                      <input
                        id="ge-wand-grow"
                        type="range"
                        min={-40}
                        max={40}
                        value={0}
                        title={NO_BACKEND}
                        disabled
                      />
                    </div>
                    {/* Visibility toggle + selection-edit action row
                        (controls.js #ge-wand-vis / clear / invert / delete /
                        copy / mask). All operate on a live selection. */}
                    <div className="ge-control-row ge-actions ge-ge-actions-wrap">
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-mask-vis-btn visible"
                        title={NO_BACKEND}
                        aria-label="Toggle selection overlay"
                        disabled
                      >
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
                          aria-label="Selection overlay"
                        >
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="delete" />
                        Clear
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="invert" />
                        Invert
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="erase" />
                        Erase
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="copy" />
                        Copy Layer
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        <SelectionIcon kind="mask" />
                        To Mask
                      </button>
                    </div>
                    <p className="ge-ge-tiny-hint">
                      Click a region to select similar pixels. Shift+click to
                      add, Alt+click to subtract. Esc to clear.
                    </p>
                  </div>
                ) : null}

                {/* Inpaint section (controls.js .ge-inpaint-section) */}
                {tool === "inpaint" ? (
                  <div className="ge-inpaint-section">
                    {/* Popover drag-head (controls.js .ge-inpaint-popover-head).
                        In odysseus this header only shows once the section is
                        torn off into a floating popover over the canvas; inline
                        in the right panel it stays hidden (matched in CSS). The
                        close control returns to the Move tool. */}
                    <div className="ge-inpaint-popover-head">
                      <div className="ge-section-title ge-section-title-with-help ge-inpaint-popover-title">
                        <span>INPAINT</span>
                      </div>
                      <button
                        type="button"
                        className="ge-inpaint-popover-close"
                        title="Close inpaint panel"
                        aria-label="Close inpaint panel"
                        onClick={() => setTool("move")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div className="ge-section-title ge-section-title-with-help">
                      <span>INPAINT</span>
                      <span
                        className="ge-section-help"
                        role="img"
                        aria-label="How inpaint works"
                        title="Brush the area you want the AI to redraw — the red preview marks the mask region. Generate fills with what your prompt describes; Remove fills with the surrounding background."
                      >
                        ?
                      </span>
                    </div>
                    <p className="ge-section-hint">
                      Generates or removes from the mask you have selected. Set{" "}
                      <strong>Strength</strong> before and adjust{" "}
                      <strong>Edge feather / stroke</strong> after.
                    </p>
                    <div className="ge-section-title ge-ge-mask-brush-title">
                      <span>Mask Brush</span>
                      <input
                        type="color"
                        className="ge-color-picker ge-inpaint-mask-color"
                        value="#ff6e6e"
                        readOnly
                        title="Mask overlay color"
                      />
                    </div>
                    <div className="ge-control-row ge-ge-mode-row">
                      <button
                        type="button"
                        className={`ge-btn ge-btn-sm ge-inpaint-mode-btn ge-ge-mode-half${inpaintMode === "paint" ? " active" : ""}`}
                        onClick={() => setInpaintMode("paint")}
                      >
                        Paint
                      </button>
                      <button
                        type="button"
                        className={`ge-btn ge-btn-sm ge-inpaint-mode-btn ge-ge-mode-half${inpaintMode === "erase" ? " active" : ""}`}
                        onClick={() => setInpaintMode("erase")}
                      >
                        Erase
                      </button>
                    </div>
                    <div className="ge-control-row ge-eraser-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-inpaint-brush-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-inpaint-brush-slider">
                        Mask Brush Size
                      </label>
                      <input
                        type="range"
                        id="ge-inpaint-brush-slider"
                        min={0}
                        max={1000}
                        value={brushSliderValue(100)}
                        readOnly
                      />
                      <span className="ge-slider-value">100px</span>
                    </div>
                    <div className="ge-control-row ge-actions ge-inpaint-mask-row">
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-mask-vis-btn visible"
                        title={NO_BACKEND}
                        aria-label="Toggle mask"
                        disabled
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          role="img"
                          aria-label="Toggle mask"
                        >
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        <span>Hide</span>
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        Invert
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-sm ge-btn-iconlabel"
                        title={NO_BACKEND}
                        disabled
                      >
                        Clear
                      </button>
                    </div>
                    <hr className="ge-section-divider" />
                    <div className="ge-section-title">
                      <span>PROMPT</span>
                    </div>
                    <input
                      type="text"
                      className="ge-inpaint-prompt"
                      placeholder="What to fill the masked area with..."
                      aria-label="Inpaint prompt"
                    />
                    <div className="ge-control-row ge-inpaint-model-row ge-ge-model-row">
                      <label htmlFor="ge-ai-inpaint">Model</label>
                      <select
                        id="ge-ai-inpaint"
                        className="ge-ai-model"
                        title="Model for inpainting"
                      >
                        <option value="">Auto</option>
                        {models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="ge-control-row ge-eraser-row ge-ge-strength-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-strength-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-strength-slider">Strength</label>
                      <input
                        id="ge-strength-slider"
                        type="range"
                        min={10}
                        max={100}
                        value={75}
                        readOnly
                      />
                      <span className="ge-slider-value">0.75</span>
                    </div>
                    <div className="ge-control-row ge-actions ge-ge-ai-actions">
                      <button
                        type="button"
                        className="ge-btn ge-btn-primary ge-btn-ai ge-ge-ai-btn"
                        disabled
                        title={NO_BACKEND}
                      >
                        <span className="ge-btn-ai-mark" aria-hidden="true">
                          ✦
                        </span>
                        Generate
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-ai ge-ge-ai-btn"
                        disabled
                        title={NO_BACKEND}
                      >
                        <span className="ge-btn-ai-mark" aria-hidden="true">
                          ✦
                        </span>
                        Remove
                      </button>
                      <button
                        type="button"
                        className="ge-btn ge-btn-ai ge-ge-ai-btn"
                        disabled
                        title={NO_BACKEND}
                      >
                        <span className="ge-btn-ai-mark" aria-hidden="true">
                          ✦
                        </span>
                        Outpaint
                      </button>
                    </div>
                    {/* POSTPROCESS group (controls.js #ge-inpaint-postedge-*).
                        Live edge-trimming of the last inpaint-result layer. The
                        sliders only exist once a Generate has produced a result
                        layer — so honestly they sit in the "Available after
                        Generate" state, with the edit sliders disabled. */}
                    <hr className="ge-section-divider" />
                    <div className="ge-section-title ge-section-title-with-help">
                      <span>POSTPROCESS</span>
                      <span
                        className="ge-section-help"
                        role="img"
                        aria-label="What this does"
                        title="Live edge trimming for the last Inpaint Result layer. Edge feather softens the alpha boundary; Edge stroke expands (+) or contracts (−) the visible edge into the AI buffer generated around your brush."
                      >
                        ?
                      </span>
                    </div>
                    <p className="ge-section-hint ge-ge-postedge-hint">
                      Available after Generate.
                    </p>
                    <div className="ge-control-row ge-eraser-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-feather-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-feather-slider">
                        Edge feather{" "}
                        <span className="ge-slider-value">0px</span>
                      </label>
                      <input
                        id="ge-feather-slider"
                        type="range"
                        min={0}
                        max={200}
                        value={0}
                        title={NO_BACKEND}
                        disabled
                      />
                    </div>
                    <div className="ge-control-row ge-eraser-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-edgestroke-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-edgestroke-slider">
                        Edge stroke <span className="ge-slider-value">0px</span>
                      </label>
                      <input
                        id="ge-edgestroke-slider"
                        type="range"
                        min={-80}
                        max={80}
                        value={0}
                        title={NO_BACKEND}
                        disabled
                      />
                    </div>
                  </div>
                ) : null}

                {/* Bg Remove section (controls.js .ge-rembg-section) */}
                {tool === "rembg" ? (
                  <div className="ge-rembg-section">
                    <div className="ge-section-title ge-section-title-with-help">
                      <span>Background Remove</span>
                      <span
                        className="ge-section-help"
                        role="img"
                        aria-label="What this does"
                        title="Runs an ML model that keeps the foreground (usually a person, product, or animal) and forces the rest transparent."
                      >
                        ?
                      </span>
                    </div>
                    <div className="ge-control-row ge-actions">
                      <button
                        type="button"
                        className="ge-btn ge-btn-primary ge-btn-ai ge-ge-ai-btn"
                        disabled
                        title={NO_BACKEND}
                      >
                        <span className="ge-btn-ai-mark" aria-hidden="true">
                          ✦
                        </span>
                        Bg Remove
                      </button>
                    </div>
                    <hr className="ge-section-divider" />
                    <div className="ge-section-title">
                      <span>Edge cleanup</span>
                    </div>
                    <div className="ge-control-row ge-eraser-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-rembg-feather-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-rembg-feather">Feather</label>
                      <input
                        id="ge-rembg-feather"
                        type="range"
                        min={0}
                        max={20}
                        value={0}
                        readOnly
                      />
                      <span className="ge-slider-value">0px</span>
                    </div>
                    <div className="ge-control-row ge-eraser-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-rembg-grow-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-rembg-grow">Edge</label>
                      <input
                        id="ge-rembg-grow"
                        type="range"
                        min={-10}
                        max={10}
                        value={0}
                        readOnly
                      />
                      <span className="ge-slider-value">0px</span>
                    </div>
                  </div>
                ) : null}

                {/* Sharpen section (controls.js .ge-sharpen-section) */}
                {tool === "sharpen" ? (
                  <div className="ge-sharpen-section">
                    <div className="ge-control-row ge-eraser-row">
                      <span
                        className="ge-eraser-preview"
                        id="ge-sharpen-preview"
                        aria-hidden="true"
                      />
                      <label htmlFor="ge-sharpen-amount">Amount</label>
                      <input
                        id="ge-sharpen-amount"
                        type="range"
                        min={10}
                        max={100}
                        value={50}
                        readOnly
                      />
                      <span className="ge-slider-value">50%</span>
                    </div>
                    <div className="ge-control-row ge-actions">
                      <button
                        type="button"
                        className="ge-btn ge-btn-primary ge-ge-ai-btn"
                        disabled
                        title={NO_BACKEND}
                      >
                        Sharpen
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Layers panel (controls.js layerPanelHTML + layer-panel.js) */}
              <div className="ge-layers">
                <div className="ge-layers-header">
                  <span className="ge-layers-grab" />
                  <span className="ge-layers-title">Layers</span>
                  <button
                    type="button"
                    className="ge-btn ge-btn-sm ge-icon-btn"
                    title="Merge down"
                    aria-label="Merge down"
                    disabled
                  >
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
                      aria-label="Merge down"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <polyline points="6 13 12 19 18 13" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="ge-btn ge-btn-sm ge-icon-btn"
                    title="Merge all"
                    aria-label="Merge all"
                    disabled
                  >
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
                      aria-label="Merge all"
                    >
                      <path d="M12 3v6M9 6l3-3 3 3M3 14h18M12 14v7M9 18l3 3 3-3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="ge-btn ge-btn-sm ge-icon-btn"
                    title="Flatten copy (keeps originals)"
                    aria-label="Flatten copy"
                    disabled
                  >
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
                      aria-label="Flatten copy"
                    >
                      <path d="M12 2 L4 6 L4 18 L12 22 L20 18 L20 6 Z" />
                      <path d="M12 2 L12 22" />
                      <path d="M4 6 L20 6" />
                      <path d="M4 18 L20 18" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="ge-btn ge-btn-sm ge-ge-add-layer"
                    title="Add empty layer"
                    disabled
                  >
                    + Add
                  </button>
                </div>
                <div className="ge-layers-list">
                  {/* Honest empty state — no canvas backend, so no layers. */}
                  <div className="ge-ge-layers-empty">
                    No layers yet. Open an image to start a layered edit.
                  </div>
                </div>
              </div>

              <div className="ge-panel-resize" title="Drag to resize panel" />
            </div>
          </div>
        </div>

        {/* ── History popover (editor/history-panel.js) — honest: only the
            genuine "Current" marker, no fabricated undo entries. ── */}
        {historyOpen ? (
          <div className="ge-history-panel ge-frosted" role="dialog">
            <div className="ge-history-head">
              <span className="ge-adj-icon">
                <RotateCcw size={14} />
              </span>
              <span className="ge-history-title">History</span>
              <span className="ge-head-btns">
                <button
                  type="button"
                  className="ge-history-close"
                  title="Close"
                  aria-label="Close history"
                  onClick={() => setHistoryOpen(false)}
                >
                  ×
                </button>
              </span>
            </div>
            <div className="ge-history-list">
              <button type="button" className="ge-history-row current">
                <span className="ge-history-row-dot" />
                <span className="ge-history-row-label">Current</span>
                <span className="ge-history-row-time">now</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* ── Shortcuts cheatsheet (editor/build/popups.js shortcutsPopupHTML) ── */}
        {shortcutsOpen ? (
          <div
            className="ge-shortcuts-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Editor shortcuts"
          >
            <button
              type="button"
              className="od-search-backdrop"
              aria-label="Close shortcuts"
              onClick={() => setShortcutsOpen(false)}
            />
            <div className="ge-shortcuts-card">
              <div className="ge-shortcuts-head">
                <span>Editor Shortcuts</span>
                <button
                  type="button"
                  className="ge-history-close"
                  aria-label="Close shortcuts"
                  onClick={() => setShortcutsOpen(false)}
                >
                  ✖
                </button>
              </div>
              <div className="ge-shortcuts-grid">
                <div className="ge-shortcuts-col">
                  <h5>Tools</h5>
                  <div>
                    <kbd>V</kbd> Move
                  </div>
                  <div>
                    <kbd>T</kbd> Transform
                  </div>
                  <div>
                    <kbd>B</kbd> Brush
                  </div>
                  <div>
                    <kbd>E</kbd> Eraser
                  </div>
                  <div>
                    <kbd>K</kbd> Clone Stamp
                  </div>
                  <div>
                    <kbd>L</kbd> Lasso
                  </div>
                  <div>
                    <kbd>W</kbd> Wand
                  </div>
                  <div>
                    <kbd>M</kbd> Inpaint
                  </div>
                  <div>
                    <kbd>C</kbd> Crop
                  </div>
                  <div>
                    <kbd>S</kbd> Sharpen
                  </div>
                </div>
                <div className="ge-shortcuts-col">
                  <h5>Edit</h5>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> Redo
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>S</kbd> Save
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> Save to
                    Gallery
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> New Layer
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> Free Transform
                  </div>
                </div>
                <div className="ge-shortcuts-col">
                  <h5>Selection</h5>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>A</kbd> Select All
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> Deselect
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>C</kbd> Copy to layer
                  </div>
                  <div>
                    <kbd>Ctrl</kbd>+<kbd>D</kbd> Delete pixels
                  </div>
                  <div>
                    <kbd>Esc</kbd> Cancel selection / crop
                  </div>
                </div>
                <div className="ge-shortcuts-col">
                  <h5>Brush / Mask</h5>
                  <div>
                    <kbd>[</kbd> Brush size −
                  </div>
                  <div>
                    <kbd>]</kbd> Brush size +
                  </div>
                </div>
              </div>
              <div className="ge-shortcuts-foot">
                Press <kbd>?</kbd> or click the keyboard icon to toggle.
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
