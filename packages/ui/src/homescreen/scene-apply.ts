/**
 * Pure reducer that applies an incoming HOMESCREEN instruction to the editor's
 * history. The agent action broadcasts these over the view-event bus; the client
 * is the authority that validates documents before they reach the renderer.
 *
 * Keeping this pure (no React, no bus) makes the apply path — the security- and
 * correctness-critical seam where untrusted model output meets the live UI —
 * fully unit-testable.
 */

import {
  commit,
  duplicate,
  redo,
  remove,
  resetToDefault,
  type SceneHistory,
  undo,
} from "./scene-history";
import { validateScene } from "./scene-validate";

/** Mirrors `HomescreenEventPayload` from the action, kept local to avoid a
 * dependency on the plugin package. */
export interface HomescreenInstruction {
  op:
    | "edit"
    | "create"
    | "undo"
    | "redo"
    | "reset"
    | "duplicate"
    | "delete"
    | "save";
  sceneJson?: string;
}

export interface ApplyResult {
  history: SceneHistory;
  /** Set when the instruction was rejected; the prior history is returned as-is. */
  error: string | null;
}

/**
 * Apply one instruction. Document ops (edit/create) parse + validate the JSON and
 * commit on success; a bad document is rejected and the history is unchanged.
 * History ops mutate the cursor/stack. `save` is a no-op here — the history is
 * already the source of truth; persistence is the host's concern.
 */
export function applyHomescreenInstruction(
  history: SceneHistory,
  instruction: HomescreenInstruction,
): ApplyResult {
  switch (instruction.op) {
    case "edit":
    case "create": {
      if (!instruction.sceneJson) {
        return { history, error: "instruction carried no scene document" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(instruction.sceneJson);
      } catch (err) {
        return {
          history,
          error: `scene document was not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      const result = validateScene(parsed);
      if (!result.ok) {
        return { history, error: result.errors.join("; ") };
      }
      return { history: commit(history, result.scene), error: null };
    }
    case "undo":
      return { history: undo(history), error: null };
    case "redo":
      return { history: redo(history), error: null };
    case "reset":
      return { history: resetToDefault(history), error: null };
    case "duplicate":
      return { history: duplicate(history), error: null };
    case "delete":
      return { history: remove(history), error: null };
    case "save":
      return { history, error: null };
  }
}
