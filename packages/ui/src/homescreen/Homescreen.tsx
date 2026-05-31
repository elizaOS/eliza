import { Copy, Pencil, Redo2, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import type { FrequencyAnalyser } from "../components/voice/VoiceWaveform";
import { cn } from "../lib/utils";
import { HomescreenCanvas } from "./HomescreenCanvas";
import type { HomescreenPhase } from "./scene-types";
import { useHomescreen } from "./useHomescreen";

export interface HomescreenProps {
  analyser?: FrequencyAnalyser | null;
  phase?: HomescreenPhase;
  userText?: string;
  assistantText?: string;
  /** Notified when edit mode flips, so the host can collapse the chat overlay. */
  onEditModeChange?: (editing: boolean) => void;
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
  onEditModeChange,
  className,
}: HomescreenProps): React.JSX.Element {
  const hs = useHomescreen();
  const [perfLabel, setPerfLabel] = useState<string>("");

  const setEditMode = (on: boolean) => {
    hs.setEditMode(on);
    onEditModeChange?.(on);
  };

  return (
    <div className={cn("absolute inset-0", className)}>
      <HomescreenCanvas
        scene={hs.scene}
        analyser={analyser}
        phase={phase}
        userText={userText}
        assistantText={assistantText}
        onPerfLabel={(label) => setPerfLabel(label)}
      />

      {/* Perf badge — always visible, low-key unless degraded. */}
      {perfLabel ? (
        <div
          data-testid="homescreen-perf"
          className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-sm bg-card/70 px-2 py-1 text-xs text-muted-strong backdrop-blur"
        >
          {perfLabel}
        </div>
      ) : null}

      {/* Edit toggle — bottom-right, out of the way of the composer. */}
      {!hs.editMode ? (
        <Button
          type="button"
          size="icon-sm"
          variant="surface"
          data-testid="homescreen-edit-toggle"
          aria-label="Edit homescreen"
          className="absolute right-3 top-3 z-20 backdrop-blur"
          onClick={() => setEditMode(true)}
        >
          <Pencil />
        </Button>
      ) : (
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
      )}

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
