import type React from "react";
import { useState } from "react";
import { Switch } from "../ui/switch";

/**
 * Collapsible policy card with toggle, summary in header, and expand-on-click.
 */
export function PolicyToggle({
  icon: Icon,
  title,
  summary,
  enabled,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  summary?: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded-xl border transition-all ${
        enabled
          ? "border-accent/30 bg-accent/5"
          : "border-border/50 bg-card/30 opacity-75"
      }`}
    >
      {/* Header — click to expand, toggle on right */}
      <div className="flex items-center justify-between p-3.5 gap-3">
        <button
          type="button"
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
          onClick={() => enabled && setExpanded((e) => !e)}
        >
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
              enabled ? "bg-accent/15 text-accent" : "bg-muted/10 text-muted"
            }`}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-txt truncate">
              {title}
            </div>
            {enabled && summary && !expanded && (
              <div className="text-xs-tight text-muted mt-0.5 truncate">
                {summary}
              </div>
            )}
            {!enabled && (
              <div className="text-xs-tight text-muted/60 mt-0.5">Off</div>
            )}
          </div>
        </button>
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={title}
        />
      </div>

      {/* Content — only when enabled + expanded */}
      {enabled && expanded && children && (
        <div className="px-3.5 py-3">{children}</div>
      )}
    </div>
  );
}
