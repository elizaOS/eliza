import { Copy, Redo2, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button";
import type { FrequencyAnalyser } from "../components/voice/VoiceWaveform";
import { cn } from "../lib/utils";
import { HomescreenCanvas, type OrbAnchor } from "./HomescreenCanvas";
import type { HomescreenPhase } from "./scene-types";
import { useHomescreen } from "./useHomescreen";

export interface HomescreenProps {
  analyser?: FrequencyAnalyser | null;
  phase?: HomescreenPhase;
  userText?: string;
  assistantText?: string;
  /** Notified when the orb's projected screen position changes (or null). */
  onOrbAnchor?: (anchor: OrbAnchor | null) => void;
  /** Notified when edit mode flips, so the host can collapse the chat overlay. */
  onEditModeChange?: (editing: boolean) => void;
  /**
   * Bumped by the host to enter edit mode from a chat command ("/edit") or a
   * voiced request ("I want to edit the homescreen"). There is no on-screen
   * edit button; this is the only way in besides an agent scene edit.
   */
  editRequestNonce?: number;
  className?: string;
}

/**
 * The full homescreen background surface: the live WebGL canvas plus the
 * customize/edit chrome. The chat, apps, and other foreground blocks live above
 * this in {@link HomeView}; here we render only the canvas and the editor
 * controls so the page composition stays in one place.
 *
 * Edit mode overlays undo / redo / reset / duplicate / delete and a live perf
 * badge — the "in case they break everything" safety net from the goal — and
 * signals the host so it can collapse the chat to a peekable overlay.
 */
export function Homescreen({
  analyser,
  phase = "idle",
  userText = "",
  assistantText = "",
  onOrbAnchor,
  onEditModeChange,
  editRequestNonce = 0,
  className,
}: HomescreenProps): React.JSX.Element {
  const hs = useHomescreen();

  const setEditMode = (on: boolean) => {
    hs.setEditMode(on);
    onEditModeChange?.(on);
  };

  // Enter edit mode when the host bumps the nonce (chat "/edit" or voice).
  const lastEditNonce = useRef(editRequestNonce);
  useEffect(() => {
    if (editRequestNonce !== lastEditNonce.current) {
      lastEditNonce.current = editRequestNonce;
      if (editRequestNonce > 0) {
        hs.setEditMode(true);
        onEditModeChange?.(true);
      }
    }
  }, [editRequestNonce, hs, onEditModeChange]);

  return (
    <div className={cn("absolute inset-0", className)}>
      <HomescreenCanvas
        scene={hs.scene}
        analyser={analyser}
        phase={phase}
        userText={userText}
        assistantText={assistantText}
        onOrbAnchor={onOrbAnchor}
      />

      {/* No on-screen edit button: edit mode is entered via the "/edit" chat
          command, a voiced request, or an agent scene edit. The toolbar only
          appears once editing is active. */}
      {hs.editMode ? (
        <div
          data-testid="homescreen-edit-toolbar"
          className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-md bg-card/80 p-1 backdrop-blur"
        >
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Undo"
            disabled={!hs.canUndo}
            onClick={hs.undo}
          >
            <Undo2 />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Redo"
            disabled={!hs.canRedo}
            onClick={hs.redo}
          >
            <Redo2 />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Duplicate"
            onClick={hs.duplicate}
          >
            <Copy />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Reset to default"
            onClick={hs.reset}
          >
            <RotateCcw />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Delete scene"
            onClick={hs.remove}
          >
            <Trash2 />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="surfaceAccent"
            aria-label="Done editing"
            onClick={() => setEditMode(false)}
          >
            <X />
          </Button>
        </div>
      ) : null}

      {hs.error ? (
        <div
          data-testid="homescreen-error"
          className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-sm bg-destructive-subtle px-3 py-1.5 text-xs text-danger"
        >
          {hs.error}
        </div>
      ) : null}
    </div>
  );
}
