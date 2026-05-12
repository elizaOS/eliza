import * as React from "react";

import { Button } from "../../ui/button";
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
  const lines = content.split("\n").length;
  const shouldTruncate = !expanded && lines > 20;
  const displayContent = shouldTruncate
    ? `${content.split("\n").slice(0, 20).join("\n")}\n...`
    : content;

  return (
    <PagePanel variant="inset" className="overflow-hidden">
      <PagePanel.Header
        heading={label}
        description={linesLabel}
        actions={
          <PagePanel.ActionRail className="rounded-full px-1 py-1">
            {lines > 20 ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="h-8 rounded-full px-3 text-xs-tight"
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? collapseLabel : expandLabel}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="h-8 rounded-full px-3 text-xs-tight"
              onClick={() => onCopy(content)}
              title={copyToClipboardLabel}
            >
              {copyLabel}
            </Button>
          </PagePanel.ActionRail>
        }
      />
      <pre className="max-h-[28rem] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words px-4 py-4 text-xs leading-6 text-txt">
        {displayContent}
      </pre>
    </PagePanel>
  );
}
