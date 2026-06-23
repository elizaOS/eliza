/**
 * GUI + XR screenshot harness for every REGISTERED plugin spatial view.
 *
 * Unlike the gallery story (12 archetypes), this page mounts the REAL plugin
 * views: it imports every `register-terminal-view.tsx` (via Vite's glob, the
 * same path the parity gate uses, so all ids register — no silent drops), then
 * for a requested id pulls the authored React thunk from the spatial view-thunk
 * registry (`getSpatialViewThunk`) and renders it through `<SpatialSurface>` on
 * the requested modality.
 *
 * The page mounts ONCE and switches the active (id, modality) in place via
 * `window.__regviews.show(id, modality)` — so the Playwright capture spec
 * navigates a single time and steps through all 33 × 2 surfaces without paying
 * a full module-graph reload per shot. `?id=&modality=` still works for manual
 * inspection.
 */
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SpatialSurface } from "../../src/spatial/index.ts";
import {
  getSpatialViewThunk,
  listTerminalViewIds,
} from "../../src/spatial/tui/index.ts";

// Register every plugin's terminal/spatial view. Eager (not lazy) so the ids
// are populated before first paint.
const registerModules = import.meta.glob(
  "../../../../plugins/*/src/**/register-terminal-view.tsx",
  { eager: true },
);

for (const mod of Object.values(registerModules)) {
  const entry = Object.entries(mod as Record<string, unknown>).find(
    ([k, v]) => typeof v === "function" && /^register.*TerminalView$/.test(k),
  );
  if (entry) (entry[1] as () => void)();
}

const REGISTERED_IDS = listTerminalViewIds().sort();

type Modality = "gui" | "xr";

declare global {
  interface Window {
    __regviews: {
      ready: boolean;
      ids: string[];
      show: (id: string, modality: Modality) => void;
    };
  }
}

function ViewPanel({ id, modality }: { id: string; modality: Modality }) {
  const element = useMemo(() => {
    const thunk = getSpatialViewThunk(id);
    return thunk ? thunk() : null;
  }, [id]);

  return (
    <div
      data-regview-panel={id}
      data-regview-modality={modality}
      style={{
        width: modality === "xr" ? 460 : 380,
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        background: "#13161c",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: "var(--muted-foreground)",
          marginBottom: 10,
        }}
      >
        {id} · {modality}
      </div>
      {element ? (
        <SpatialSurface modality={modality}>{element}</SpatialSurface>
      ) : (
        <div style={{ color: "var(--destructive)" }}>
          no registered view thunk for "{id}"
        </div>
      )}
    </div>
  );
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const initialId = params.get("id") ?? REGISTERED_IDS[0];
  const initialModality = (params.get("modality") as Modality) ?? "gui";

  const [active, setActive] = useState<{ id: string; modality: Modality }>({
    id: initialId,
    modality: initialModality,
  });

  const show = useCallback((id: string, modality: Modality) => {
    setActive({ id, modality });
  }, []);

  useEffect(() => {
    window.__regviews = { ready: true, ids: REGISTERED_IDS, show };
  }, [show]);

  const known = REGISTERED_IDS.includes(active.id);

  // One panel at scroll-top so the capture spec screenshots its element bbox.
  return (
    <div data-regview-single style={{ display: "inline-block" }}>
      {known ? (
        <ViewPanel
          key={`${active.id}-${active.modality}`}
          id={active.id}
          modality={active.modality}
        />
      ) : (
        <div style={{ color: "var(--destructive)" }}>
          unknown view id "{active.id}"
        </div>
      )}
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
