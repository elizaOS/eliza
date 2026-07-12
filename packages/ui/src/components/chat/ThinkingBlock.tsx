/**
 * Renders assistant thinking and trace blocks inside chat messages without
 * changing the message parser contract.
 */
import { type ReactElement, useState } from "react";
import { Button } from "../ui/button";

/**
 * Collapsed-by-default "Thinking" disclosure that renders an assistant turn's
 * reasoning/thought as a separate channel from the visible reply. Styling
 * reuses the analysis-xml tokens (orange accent only, no blue) so it reads as
 * the same kind of inspectable side-channel.
 *
 * Shared by {@link MessageContent} (full chat) and the continuous chat overlay
 * so the two surfaces render reasoning identically.
 */
export function ThinkingBlock({
  reasoning,
}: {
  reasoning: string;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const trimmed = reasoning.trim();
  if (!trimmed) {
    return null;
  }
  // Chrome-free disclosure: a bare accent toggle line, and when open the
  // reasoning indented behind a thin accent left rule — no box, no fill, the
  // minimum a reader needs to find and expand the side-channel.
  return (
    <div className="my-1.5">
      <Button
        variant="ghost"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="h-auto justify-start gap-1.5 rounded-none bg-transparent p-0 text-xs font-bold text-accent uppercase tracking-wider transition-colors hover:bg-transparent hover:text-accent/80"
      >
        <span
          aria-hidden="true"
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
        Thinking
      </Button>
      {open ? (
        <pre className="m-0 mt-1.5 overflow-x-auto whitespace-pre-wrap break-words border-l-2 border-accent/30 pl-3 text-xs font-mono opacity-80">
          {trimmed}
        </pre>
      ) : null}
    </div>
  );
}
