/**
 * useBackgroundApplyChannel — the single bridge that lets the agent drive the
 * unified app background from chat.
 *
 * The agent's BACKGROUND action broadcasts a `background:apply` view event
 * (server → WS → `emitViewEvent`); this hook is the one subscriber, applying it
 * to the same `BackgroundConfig` store the Background view and `AppBackground`
 * share. There is no second background mechanism: chat, the view, and undo all
 * funnel through `setBackgroundConfig` / `undoBackgroundConfig`.
 *
 * Mounted once, alongside `AppBackground` at the shell root, so it is always
 * listening regardless of which view is active — "make the background blue"
 * works from anywhere, not only on the Background view.
 */

import { useViewEvent } from "../hooks/useViewEvent";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_CONFIG,
} from "../state/ui-preferences";
import { useBackgroundConfig } from "../state/useBackgroundConfig";

/** View-event type the BACKGROUND action broadcasts. Keep in sync with the
 * literal used in `plugins/plugin-app-control/src/actions/background.ts`. */
export const BACKGROUND_APPLY_EVENT = "background:apply";

/** Operation carried by a `background:apply` event payload. */
export type BackgroundApplyOp = "set" | "undo" | "redo" | "reset";

export function useBackgroundApplyChannel(): void {
  const {
    backgroundConfig,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
  } = useBackgroundConfig();

  useViewEvent(BACKGROUND_APPLY_EVENT, (event) => {
    const payload = event.payload;
    const op = typeof payload.op === "string" ? payload.op : "set";

    if (op === "undo") {
      undoBackgroundConfig();
      return;
    }
    if (op === "redo") {
      // Forward half of undo/redo (#10694) — re-apply the last undone config.
      redoBackgroundConfig();
      return;
    }
    if (op === "reset") {
      setBackgroundConfig(DEFAULT_BACKGROUND_CONFIG);
      return;
    }

    // op === "set": build a config from the payload. `setBackgroundConfig`
    // normalizes (bad hex → default, image-without-url → shader), so a partial
    // or malformed payload can never wedge the background into a broken state.
    const imageUrl =
      typeof payload.imageUrl === "string" && payload.imageUrl.length > 0
        ? payload.imageUrl
        : undefined;
    const color = typeof payload.color === "string" ? payload.color : undefined;
    const wantsImage = payload.mode === "image" || (!payload.mode && imageUrl);

    if (wantsImage && imageUrl) {
      setBackgroundConfig({
        mode: "image",
        color: color ?? backgroundConfig.color ?? DEFAULT_BACKGROUND_COLOR,
        imageUrl,
      });
    } else if (color) {
      setBackgroundConfig({ mode: "shader", color });
    }
  });
}
