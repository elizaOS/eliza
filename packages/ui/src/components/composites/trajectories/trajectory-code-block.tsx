/**
 * Labelled, copyable code block used across the trajectory viewer for prompt
 * and response payloads. Collapses to a preview past 20 lines with an
 * expand/collapse toggle and a copy-to-clipboard button.
 */
import * as React from "react";

import { Button } from "../../ui/button";
import { CodeBlock } from "../../ui/code-block";
import { PagePanel } from "../page-panel";

export interface TrajectoryCodeBlockProps {
  collapseLabel: React.ReactNode;
  content: string;
  copyLabel: React.ReactNode;
  copyToClipboardLabel?: string;
  expandLabel: React.ReactNode;
  label: React.ReactNode;
  linesLabel: React.ReactNode;
  onCopy: (content: string) => void;
}

export function TrajectoryCodeBlock({
  collapseLabel,
  content,
  copyLabel,
  copyToClipboardLabel,
  expandLabel,
  label,
  linesLabel,
  onCopy,
}: TrajectoryCodeBlockProps) {
  const [expanded, setExpanded] = React.useState(false);
  const contentLines = React.useMemo(() => content.split("\n"), [content]);
  const lines = contentLines.length;
  const shouldTruncate = !expanded && lines > 20;
  const displayContent = shouldTruncate
    ? `${contentLines.slice(0, 20).join("\n")}\n...`
    : content;

  return (
    <PagePanel variant="inset" className="overflow-hidden">
      <PagePanel.Header
        heading={label}
        description={linesLabel}
        actions={
          <PagePanel.ActionRail className="p-1">
            {lines > 20 ? (
              <Button
                variant="outline"
                size="dense"
                type="button"
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? collapseLabel : expandLabel}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="dense"
              type="button"
              onClick={() => onCopy(content)}
              title={copyToClipboardLabel}
            >
              {copyLabel}
            </Button>
          </PagePanel.ActionRail>
        }
      />
      <CodeBlock
        value={displayContent}
        presentation="attachment"
        wrap
        tabIndex={0}
        aria-label={typeof label === "string" ? label : "Trajectory content"}
        className="max-h-112 break-words p-4"
      />
    </PagePanel>
  );
}
