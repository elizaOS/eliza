// The 8 edge/corner resize grips for a windowed odysseus tool view
// (static/js/windowResize.js). Render inside the panel; each grip wires the
// matching direction into the window controls. No-ops visually until the panel
// is windowed, but harmless to always render.

import type { ReactNode } from "react";
import type { ResizeDir, WindowControls } from "./hooks/useWindowControls";

const DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function ResizeHandles({
  controls,
}: {
  controls: WindowControls;
}): ReactNode {
  if (!controls.windowed) return null;
  return (
    <>
      {DIRS.map((dir) => (
        <div
          key={dir}
          className={`od-rz-handle od-rz-${dir}`}
          onPointerDown={controls.onResizeStart(dir)}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
