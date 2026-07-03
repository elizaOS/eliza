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
  return (
    <div className="my-2 border border-accent/20 rounded-sm bg-accent/5 overflow-hidden">
      <Button
        variant="ghost"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="h-auto w-full justify-start gap-1.5 rounded-none bg-accent/10 px-3 py-1 text-xs font-bold text-accent uppercase tracking-wider transition-colors hover:bg-accent/20"
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
        <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words opacity-80 m-0 overflow-x-auto">
          {trimmed}
        </pre>
      ) : null}
    </div>
  );
}
