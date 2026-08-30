/**
 * Renders assistant thinking and trace blocks inside chat messages without
 * changing the message parser contract.
 */
import { type ReactElement, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

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
    <Card
      surface="accentSubtle"
      border="accent"
      className="my-2 overflow-hidden"
    >
      <Button
        variant="sectionToggle"
        size="content"
        align="start"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
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
    </Card>
  );
}
