/**
 * Edit which `chat-sidebar` widgets are visible.
 *
 * Renders inline inside the chat widgets sidebar, replacing the normal widget
 * content while the user is editing. Toggling a row clears or sets a user
 * visibility override — toggling back to the default clears the override
 * entirely so future default changes still propagate.
 */

import { Button, Switch } from "@elizaos/ui";
import { LayoutGrid } from "lucide-react";
import type { ReactNode } from "react";
import type { ChatSidebarVisibilityHook } from "../../widgets/useChatSidebarVisibility";
import {
  APPS_SECTION_VISIBILITY_KEY,
  type VisibilityCandidate,
} from "../../widgets/visibility";

export interface WidgetVisibilityCandidate extends VisibilityCandidate {
  /** Display label shown next to the toggle. */
  label: string;
  /** Optional icon node rendered to the left of the label. */
  icon?: ReactNode;
}

export interface WidgetVisibilityEditorProps {
  candidates: readonly WidgetVisibilityCandidate[];
  visibility: ChatSidebarVisibilityHook;
  onClose: () => void;
}

const APPS_SECTION_PARTS = APPS_SECTION_VISIBILITY_KEY.split("/");

export function buildAppsSectionVisibilityCandidate(): WidgetVisibilityCandidate {
  return {
    pluginId: APPS_SECTION_PARTS[0] ?? "app-core",
    id: APPS_SECTION_PARTS[1] ?? "apps.section",
    defaultEnabled: true,
    label: "Apps",
    icon: <LayoutGrid className="h-3.5 w-3.5" />,
  };
}

export function WidgetVisibilityEditor({
  candidates,
  visibility,
  onClose,
}: WidgetVisibilityEditorProps) {
  const hasAnyOverride = Object.keys(visibility.overrides).length > 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="widget-visibility-editor"
    >
      <div className="border-b border-border/30 px-3 py-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted">
          Edit widgets
        </span>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 py-2"
        data-testid="widget-visibility-list"
      >
        {candidates.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">
            No widgets are available right now.
          </p>
        ) : (
          <ul className="flex flex-col">
            {candidates.map((candidate) => {
              const checked = visibility.isVisible(candidate);
              const rowKey = `${candidate.pluginId}/${candidate.id}`;
              return (
                <li
                  key={rowKey}
                  data-testid={`widget-visibility-row-${rowKey}`}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-2 hover:bg-bg-hover/40"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {candidate.icon ? (
                      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted">
                        {candidate.icon}
                      </span>
                    ) : null}
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-xs text-txt">
                        {candidate.label}
                      </span>
                      <span className="truncate text-3xs uppercase tracking-wider text-muted/70">
                        {candidate.pluginId}
                      </span>
                    </div>
                  </div>
                  <Switch
                    checked={checked}
                    onCheckedChange={(next) =>
                      visibility.setVisible(candidate, next)
                    }
                    aria-label={`Toggle ${candidate.label}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border/30 px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!hasAnyOverride}
          onClick={() => visibility.reset()}
        >
          Reset
        </Button>
        <Button type="button" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
