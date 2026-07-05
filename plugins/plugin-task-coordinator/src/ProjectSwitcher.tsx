/**
 * ProjectSwitcher — the per-project switcher affordance (#13776 item 5).
 *
 * Reads the merged core project registry through `client.listProjects()` and
 * lets the user switch the active project via `client.activateProject(id)`.
 * The active project drives the task list's `projectId` filter (the caller
 * passes `onActiveProjectChange` and threads the id into its task fetch).
 *
 * Design: a compact dropdown trigger showing the active project's name (or a
 * neutral "All projects" label when none is active), matching the task panel's
 * header chrome — design tokens only (no raw hex, no purple/blue, no
 * backdrop-blur), a single lucide folder glyph, and a check mark on the active
 * row.
 *
 * The switcher self-hides in the degenerate case of zero or one project
 * (#14112): most users only ever open a single workspace folder, and a control
 * with nothing to switch *between* is dead chrome — the single-project panel
 * header must stay identical to pre-switcher builds. It appears only once a
 * second project is registered. In the hidden case it reports a `null`
 * projectId to the host so the task list stays unfiltered exactly like today.
 */
import {
  Button,
  client,
  type ProjectSummary,
  useAppSelectorShallow,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
// Direct subpath (mirrors the sibling panels): the browser barrel doesn't
// reliably re-export the newer dropdown-menu primitives.
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@elizaos/ui/components/ui/dropdown-menu";
import { Check, FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const fallbackTranslate = (
  key: string,
  vars?: Record<string, unknown>,
): string => String(vars?.defaultValue ?? key);

export interface ProjectSwitcherProps {
  /** Fired with the active project id after initial registry load and after a
   *  successful switch, so the host can re-filter its task list before it fetches. */
  onActiveProjectChange?: (projectId: string | null) => void;
}

interface ProjectSwitcherState {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  loading: boolean;
  switching: boolean;
  error: string | null;
}

const INITIAL_STATE: ProjectSwitcherState = {
  projects: [],
  activeProjectId: null,
  loading: true,
  switching: false,
  error: null,
};

export function ProjectSwitcher({
  onActiveProjectChange,
}: ProjectSwitcherProps) {
  const { t: appT } = useAppSelectorShallow((s) => ({ t: s.t }));
  const t = appT ?? fallbackTranslate;
  const [state, setState] = useState<ProjectSwitcherState>(INITIAL_STATE);

  const loadProjects = useCallback(
    async (signal: { cancelled: boolean }) => {
      try {
        const { projects, activeProjectId } = await client.listProjects();
        if (signal.cancelled) return;
        setState((prev) => ({
          ...prev,
          projects,
          activeProjectId,
          loading: false,
          error: null,
        }));
        // With 0 or 1 project the switcher is hidden (see the render guard), so
        // the task list must behave exactly like today: unfiltered, including
        // project-unbound tasks. Only report a filtering projectId once there
        // are ≥2 projects to switch between (#14112).
        onActiveProjectChange?.(projects.length > 1 ? activeProjectId : null);
      } catch (error) {
        if (signal.cancelled) return;
        setState((prev) => ({
          ...prev,
          projects: [],
          activeProjectId: null,
          loading: false,
          error: error instanceof Error ? error.message : "Unknown",
        }));
        onActiveProjectChange?.(null);
      }
    },
    [onActiveProjectChange],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void loadProjects(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [loadProjects]);

  const handleSelect = useCallback(
    async (projectId: string) => {
      if (projectId === state.activeProjectId || state.switching) return;
      setState((prev) => ({ ...prev, switching: true, error: null }));
      try {
        const activated = await client.activateProject(projectId);
        setState((prev) => ({
          ...prev,
          activeProjectId: activated.id,
          // Reflect the freshly-stamped lastOpenedAt in the list too.
          projects: prev.projects.map((p) =>
            p.id === activated.id ? { ...p, ...activated } : p,
          ),
          switching: false,
        }));
        onActiveProjectChange?.(activated.id);
      } catch (error) {
        setState((prev) => ({
          ...prev,
          switching: false,
          error: error instanceof Error ? error.message : "Unknown",
        }));
      }
    },
    [state.activeProjectId, state.switching, onActiveProjectChange],
  );

  const triggerLabel = t("projectswitcher.trigger", {
    defaultValue: "Switch project",
  });
  const { ref: triggerRef, agentProps: triggerAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "project-switcher-trigger",
      role: "button",
      label: triggerLabel,
      group: "project-switcher",
      description: "Open the project switcher to change the active project",
    });

  if (state.loading) {
    return null;
  }

  if (state.error && state.projects.length === 0) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled
        data-testid="project-switcher-error"
        title={state.error}
        className="inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-xl border border-danger/40 bg-danger/10 px-2.5 text-xs font-medium text-danger"
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {t("projectswitcher.unavailable", {
            defaultValue: "Projects unavailable",
          })}
        </span>
      </Button>
    );
  }

  // Hide entirely in the degenerate case of zero or one registered project: a
  // switcher with nothing to switch *between* is dead chrome. This keeps the
  // single-project experience byte-identical to pre-switcher builds (#14112) —
  // most users only ever open one workspace folder, so the panel header must
  // stay unchanged for them; the switcher only earns its place once a second
  // project exists to switch to (mobile/web with no registry also lands here).
  if (state.projects.length <= 1) {
    return null;
  }

  const active =
    state.projects.find((p) => p.id === state.activeProjectId) ?? null;
  const activeName =
    active?.name ?? t("projectswitcher.none", { defaultValue: "All projects" });
  const switchFailedLabel = t("projectswitcher.switchFailed", {
    defaultValue: "Project switch failed",
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="secondary"
          size="sm"
          disabled={state.switching}
          data-testid="project-switcher-trigger"
          aria-label={triggerLabel}
          className="inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-xl border border-border/50 bg-bg-accent/30 px-2.5 text-xs font-medium text-txt hover:text-txt-strong"
          {...triggerAgentProps}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="truncate">{activeName}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[13rem]"
        data-testid="project-switcher-menu"
      >
        {state.projects.map((project) => {
          const isActive = project.id === state.activeProjectId;
          return (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => {
                void handleSelect(project.id);
              }}
              data-testid={`project-switcher-item-${project.id}`}
              data-active={isActive ? "true" : undefined}
              className="flex items-start gap-2"
            >
              <Check
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                  isActive ? "text-accent" : "text-transparent"
                }`}
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium text-txt">
                  {project.name}
                </span>
                <span className="truncate text-2xs text-muted">
                  {project.localPath}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
        {state.error ? (
          <div
            className="px-2 py-1.5 text-2xs text-danger"
            data-testid="project-switcher-error"
            role="alert"
          >
            {switchFailedLabel}: {state.error}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
