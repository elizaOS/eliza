import { Brain, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MarkdownText } from "./orchestrator-markdown";

// Luminance-sweep shimmer keyframes for the streaming reasoning cell. This is
// the canonical copy of the rule that also lives in ODYSSEUS_CSS
// (odysseus/odysseus-theme.ts) for the /odysseus shell. The cell renders in two
// surfaces — the standalone OrchestratorWorkbench timeline (/orchestrator),
// which does NOT inject ODYSSEUS_CSS, and the odysseus shell, which does — so
// the cell carries the rule itself rather than assuming the shell stylesheet is
// present. It is emitted via a React-hoistable <style href precedence> (below):
// React lifts it to <head> and DEDUPLICATES every identical href to a single
// DOM node, so N cells across any number of renders inject the rule exactly
// once (the per-instance <style> this replaces injected one tag per cell). The
// reduced-motion guard drops the animation and the mask entirely.
const REASONING_SHIMMER_CSS = `
.orchestrator-reasoning-shimmer {
  -webkit-mask-image: linear-gradient(
    100deg,
    rgba(0, 0, 0, 0.45) 30%,
    rgba(0, 0, 0, 1) 50%,
    rgba(0, 0, 0, 0.45) 70%
  );
  mask-image: linear-gradient(
    100deg,
    rgba(0, 0, 0, 0.45) 30%,
    rgba(0, 0, 0, 1) 50%,
    rgba(0, 0, 0, 0.45) 70%
  );
  -webkit-mask-size: 220% 100%;
  mask-size: 220% 100%;
  animation: orchestrator-reasoning-sweep 1.8s linear infinite;
}
@keyframes orchestrator-reasoning-sweep {
  from {
    -webkit-mask-position: 180% 0;
    mask-position: 180% 0;
  }
  to {
    -webkit-mask-position: -80% 0;
    mask-position: -80% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .orchestrator-reasoning-shimmer {
    -webkit-mask-image: none;
    mask-image: none;
    animation: none;
  }
}
`;

// A collapsible "reasoning / thinking" cell, matching the Codex / opencode
// shape: a dim one-line header you can expand into the model's raw chain of
// thought. The cloud-ui ai-elements `Reasoning` primitive
// (packages/ui/.../ai-elements/reasoning.tsx) carries a Radix
// `useControllableState` + auto-open/auto-close timer machine and its own
// `text-muted-foreground`/`text-sm` skin keyed to seconds. Our contract is a
// flat presentational `{ text, durationMs, streaming }` with a humanized
// duration, a `MarkdownText` body, and an in-token shimmer — none of which that
// primitive exposes — so we build a self-contained collapsible on the same
// useState open/setOpen pattern the sibling tool-call cell uses, re-skinned to
// eliza tokens (text-2xs, text-muted, rounded-md, border-border/50).

/** Humanize a stopwatch duration the way Codex's header reads: sub-minute as
 * whole seconds, then minutes (+ trailing seconds). Display-only rounding. */
function humanizeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * A collapsed-by-default reasoning cell. While the model is still thinking the
 * header reads "Thinking…" and the body text gets a luminance-sweep shimmer;
 * once finished it reads "Thought for {duration}". The shimmer is a CSS
 * mask-image sweep over the SAME `text-muted` glyphs — it introduces no new
 * color, and it is disabled under `prefers-reduced-motion`.
 *
 * Pure presentational: it renders only from its props and owns no data.
 *
 * @param props.text - The reasoning / chain-of-thought markdown to render.
 * @param props.durationMs - Total thinking time in ms; humanized in the header.
 * @param props.streaming - Whether reasoning is still arriving (drives the
 *   "Thinking…" label and the shimmer).
 */
export function ReasoningCell({
  text,
  durationMs,
  streaming,
}: {
  text: string;
  durationMs?: number;
  streaming?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);

  const header = streaming
    ? "Thinking…"
    : durationMs !== undefined
      ? `Thought for ${humanizeDuration(durationMs)}`
      : "Thought";

  return (
    <div
      className="rounded-md border border-border/50 bg-card/50"
      data-testid="orchestrator-reasoning"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <Brain className="h-3.5 w-3.5 shrink-0 text-muted-strong" />
        <span
          className={`min-w-0 flex-1 truncate text-2xs italic text-muted ${
            // The header itself gets the shimmer while streaming so the cell
            // reads as "alive" even when collapsed.
            streaming ? "orchestrator-reasoning-shimmer" : ""
          }`}
        >
          {header}
        </span>
      </button>
      {open ? (
        <div className="px-2.5 pb-2">
          <div
            className={`text-2xs italic text-muted ${
              streaming ? "orchestrator-reasoning-shimmer" : ""
            }`}
          >
            <MarkdownText text={text} />
          </div>
        </div>
      ) : null}
      {/* React-hoistable, deduplicated stylesheet: the shared `href` collapses
          every ReasoningCell's copy of this rule to a single <head> node, so it
          is emitted once regardless of how many cells mount or re-render. */}
      <style href="orchestrator-reasoning-shimmer" precedence="default">
        {REASONING_SHIMMER_CSS}
      </style>
    </div>
  );
}
