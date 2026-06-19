/**
 * Live 3-paradigm gallery. For every screen archetype it renders the SAME
 * authored view to three columns:
 *   - GUI  — <SpatialSurface modality="gui">  (DOM)
 *   - XR   — <SpatialSurface modality="xr">   (DOM, spatially scaled)
 *   - TUI  — real terminal lines (precomputed Node-side) shown as ANSI HTML
 * so a screenshot of this page verifies tri-modal parity per screen.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GALLERY } from "../../src/spatial/gallery.tsx";
import { SpatialSurface } from "../../src/spatial/index.ts";
import tuiData from "./spatial-gallery-tui.json";

const TUI: Record<string, Record<string, string[]>> = tuiData;

// --- ANSI (SGR) → HTML ------------------------------------------------------

const FG: Record<number, string> = {
  30: "#1f2430",
  31: "#ef4444",
  32: "#22c55e",
  33: "#e8590c",
  34: "#3b82f6",
  35: "#a855f7",
  36: "#06b6d4",
  37: "#cbd0d8",
  90: "#6b7280",
  91: "#f87171",
  92: "#4ade80",
  93: "#fbbf24",
  94: "#60a5fa",
  95: "#c084fc",
  96: "#22d3ee",
  97: "#f3f4f6",
};

interface SgrState {
  bold: boolean;
  dim: boolean;
  underline: boolean;
  inverse: boolean;
  fg: string | null;
}

function freshState(): SgrState {
  return {
    bold: false,
    dim: false,
    underline: false,
    inverse: false,
    fg: null,
  };
}

function applyCodes(state: SgrState, params: number[]): void {
  for (const c of params) {
    if (c === 0) Object.assign(state, freshState());
    else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 4) state.underline = true;
    else if (c === 7) state.inverse = true;
    else if (c === 22) {
      state.bold = false;
      state.dim = false;
    } else if (c === 24) state.underline = false;
    else if (c === 27) state.inverse = false;
    else if (c === 39) state.fg = null;
    else if (FG[c]) state.fg = FG[c];
  }
}

function styleFor(state: SgrState): React.CSSProperties {
  const fg = state.fg ?? "#cbd0d8";
  const css: React.CSSProperties = {};
  if (state.inverse) {
    css.background = fg;
    css.color = "#0f1115";
  } else {
    css.color = fg;
  }
  if (state.bold) css.fontWeight = 700;
  if (state.dim) css.opacity = 0.65;
  if (state.underline) css.textDecoration = "underline";
  return css;
}

function ansiLineToSpans(line: string, key: number): React.ReactNode {
  const state = freshState();
  const parts: React.ReactNode[] = [];
  let buf = "";
  let i = 0;
  let spanKey = 0;
  const flush = () => {
    if (buf) {
      parts.push(
        <span key={spanKey++} style={styleFor(state)}>
          {buf}
        </span>,
      );
      buf = "";
    }
  };
  while (i < line.length) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && line[j] !== "m") j++;
      flush();
      const params = line
        .slice(i + 2, j)
        .split(";")
        .map((p) => Number.parseInt(p || "0", 10));
      applyCodes(state, params);
      i = j + 1;
    } else {
      buf += line[i];
      i++;
    }
  }
  flush();
  return (
    <div key={key} style={{ whiteSpace: "pre" }}>
      {parts.length ? parts : " "}
    </div>
  );
}

// --- Panels -----------------------------------------------------------------

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.8,
        textTransform: "uppercase",
        color: "var(--muted-foreground)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function DomPanel({
  modality,
  view,
}: {
  modality: "gui" | "xr";
  view: () => React.ReactNode;
}) {
  return (
    <div
      style={{
        width: modality === "xr" ? 420 : 360,
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 14,
        background: "#13161c",
      }}
    >
      <PanelLabel>{modality}</PanelLabel>
      <SpatialSurface modality={modality}>{view()}</SpatialSurface>
    </div>
  );
}

function TuiPanel({ id }: { id: string }) {
  const lines = TUI[id]?.["54"] ?? ["(no tui render)"];
  return (
    <div
      style={{
        width: 480,
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 14,
        background: "#13161c",
      }}
    >
      <PanelLabel>tui — terminal (54 cols)</PanelLabel>
      <div
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12.5,
          lineHeight: "1.35",
          background: "#0b0d11",
          color: "#cbd0d8",
          borderRadius: 8,
          padding: "12px 14px",
          overflowX: "auto",
        }}
      >
        {lines.map((l, idx) => ansiLineToSpans(l, idx))}
      </div>
    </div>
  );
}

function ScreenRow({
  id,
  title,
  description,
  view,
}: {
  id: string;
  title: string;
  description: string;
  view: () => React.ReactNode;
}) {
  return (
    <section
      data-screen={id}
      style={{
        padding: "20px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ marginBottom: 14 }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{title}</span>
        <span
          style={{
            color: "var(--muted-foreground)",
            marginLeft: 10,
            fontSize: 13,
          }}
        >
          {description}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          gap: 18,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <DomPanel modality="gui" view={view} />
        <DomPanel modality="xr" view={view} />
        <TuiPanel id={id} />
      </div>
    </section>
  );
}

function App() {
  // `?screen=<id>` renders a single screen at the top (the screenshot tool
  // always captures scroll 0, so per-screen URLs are how we verify each one).
  const only = new URLSearchParams(window.location.search).get("screen");
  const screens = only ? GALLERY.filter((s) => s.id === only) : GALLERY;
  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <header style={{ marginBottom: 8 }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 26 }}>
          Spatial — one view, three modalities
        </h1>
        <p style={{ margin: 0, color: "var(--muted-foreground)" }}>
          Every screen below is authored once with the spatial primitives and
          rendered to GUI (DOM), XR (scaled DOM), and TUI (real terminal lines).
        </p>
      </header>
      {screens.map((s) => (
        <ScreenRow
          key={s.id}
          id={s.id}
          title={s.title}
          description={s.description}
          view={s.view}
        />
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
