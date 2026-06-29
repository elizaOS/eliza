/**
 * Scene e2e fixture — mounts the REAL `XRSpatialScene` (@elizaos/ui/spatial) with
 * the spatial gallery's authored views as 3D panels, so the IWER harness can run
 * the full pose → ray → 3D hit → press → drag loop against actual views in a real
 * browser (not a hand-rolled stub). Built to an IIFE by `vite.scene.config.ts`
 * and served at `/scene` by `e2e/serve.mjs`; the Playwright fixture injects the
 * emulator (navigator.xr polyfill) before this loads.
 */

import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { SpatialAction } from "@spatial/context.ts";
import { GALLERY } from "@spatial/gallery.tsx";
import { type XRPanelSpec, XRSpatialScene } from "@spatial/xr-scene.tsx";

const GALLERY_BY_ID = new Map(GALLERY.map((g) => [g.id, g]));
const ALL_IDS = GALLERY.map((g) => g.id);

interface FixtureApi {
  /** All gallery view ids available to mount. */
  galleryIds: string[];
  /** Re-mount the scene with exactly these gallery view ids as panels. */
  setPanels(ids: string[]): void;
  /** SpatialActions the scene has dispatched (press/change/submit/move). */
  actions: SpatialAction[];
  clearActions(): void;
}

declare global {
  interface Window {
    __xrSceneFixture: FixtureApi;
  }
}

const actions: SpatialAction[] = [];
let externalSetIds: ((ids: string[]) => void) | null = null;

function App() {
  const [ids, setIds] = useState<string[]>(ALL_IDS);
  externalSetIds = setIds;

  const panels: XRPanelSpec[] = ids
    .map((id) => GALLERY_BY_ID.get(id))
    .filter((g): g is NonNullable<typeof g> => Boolean(g))
    .map((g) => ({ id: g.id, content: g.view() }));

  return (
    <XRSpatialScene
      panels={panels}
      onAction={(a) => {
        actions.push(a);
      }}
    />
  );
}

window.__xrSceneFixture = {
  galleryIds: ALL_IDS,
  setPanels(ids) {
    externalSetIds?.(ids);
  },
  actions,
  clearActions() {
    actions.length = 0;
  },
};

const host = document.getElementById("root");
if (host) createRoot(host).render(<App />);
