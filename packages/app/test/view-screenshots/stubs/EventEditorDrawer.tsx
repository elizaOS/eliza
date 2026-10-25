/**
 * Stub for plugin-calendar's `./EventEditorDrawer.js`. The real drawer makes
 * `client`/network calls on save/create/delete; the harness only needs the grid
 * to render, so the drawer renders nothing while closed (its initial state).
 */

import type { ReactNode } from "react";

export function EventEditorDrawer(props: {
  open: boolean;
  mode?: string;
  event?: { title?: string } | null;
}): ReactNode {
  if (!props.open) return null;
  return (
    <div data-testid={`event-editor-drawer-${props.mode}`}>
      <span data-testid="drawer-event-title">{props.event?.title ?? ""}</span>
    </div>
  );
}

export default EventEditorDrawer;
