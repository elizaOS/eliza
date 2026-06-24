import { SlidersHorizontal } from "lucide-react";
import * as React from "react";
import {
  type WidgetVisibilityCandidate,
  WidgetVisibilityEditor,
} from "../components/chat/WidgetVisibilityPanel";
import { useActivityEvents } from "../hooks/useActivityEvents";
import { cn } from "../lib/utils";
import { useAppSelector } from "../state";
import { resolveWidgetsForSlot } from "./registry";
import { useWidgetVisibility } from "./useChatSidebarVisibility";
import { isWidgetVisible, type VisibilityCandidate } from "./visibility";
import { WidgetHost } from "./WidgetHost";

export interface HomeWidgetsSurfaceProps {
  className?: string;
  hostClassName?: string;
}

function usePluginSnapshot() {
  const plugins = useAppSelector((s) => s.plugins);
  return Array.isArray(plugins) ? plugins : [];
}

export function HomeWidgetsSurface({
  className,
  hostClassName,
}: HomeWidgetsSurfaceProps) {
  const plugins = usePluginSnapshot();
  const { events, clearEvents } = useActivityEvents();
  const visibility = useWidgetVisibility("home");
  const [editOpen, setEditOpen] = React.useState(false);

  const candidates = React.useMemo<readonly WidgetVisibilityCandidate[]>(
    () =>
      resolveWidgetsForSlot("home", plugins)
        .filter((entry) => !entry.defaultWidgetSink)
        .map(({ declaration }) => ({
          pluginId: declaration.pluginId,
          id: declaration.id,
          defaultEnabled: declaration.defaultEnabled,
          label: declaration.label,
        })),
    [plugins],
  );

  const filter = React.useCallback(
    (declaration: VisibilityCandidate) =>
      isWidgetVisible(declaration, visibility.overrides),
    [visibility.overrides],
  );

  return (
    <div
      className={cn("mx-auto w-full max-w-2xl pb-3", className)}
      data-testid="home-widgets-surface"
    >
      <div className="mb-2 flex justify-end px-1">
        <button
          type="button"
          data-testid="home-widgets-edit"
          aria-label="Edit home widgets"
          title="Edit home widgets"
          onClick={() => setEditOpen((open) => !open)}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-bg-accent hover:text-txt",
            editOpen ? "bg-accent-subtle text-accent" : "text-muted",
          )}
          aria-pressed={editOpen}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {editOpen ? (
        <div className="mb-3 max-w-md overflow-hidden rounded-sm border border-border/40 bg-bg">
          <WidgetVisibilityEditor
            candidates={candidates}
            visibility={visibility}
            onClose={() => setEditOpen(false)}
          />
        </div>
      ) : null}
      <WidgetHost
        slot="home"
        layout="grid"
        events={events}
        clearEvents={clearEvents}
        className={cn("px-1", hostClassName)}
        filter={filter}
      />
    </div>
  );
}
