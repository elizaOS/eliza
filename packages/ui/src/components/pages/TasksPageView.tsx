/**
 * Project-first creator surface at the stable `tasks` tab and `/apps/tasks`
 * route. It joins the local project registry with installed-package run state
 * and live Cloud publication, keeps creation and folder import on the existing
 * app lifecycle APIs, and drills into one project through the `projectId`
 * query parameter.
 *
 * Coding-task activity remains owned by the task-coordinator slot. Builds that
 * do not ship that plugin still retain project, installed-package, and Run
 * management, with an explicit unavailable state in the activity panel.
 */
import {
  Activity,
  ChevronRight,
  Clock3,
  FolderGit2,
  Play,
  Square,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  AppRunSummary,
  InstalledAppInfo,
  ProjectSummary,
} from "../../api/client-types-cloud";
import { navigateBrowserPath } from "../../app-navigate-view";
import { ProjectPublicationBadge } from "../../cloud/applications/components/project-publication-badge";
import {
  getWindowNavigationPath,
  shouldUseHashNavigation,
} from "../../navigation";
import { CodingAgentTasksPanel } from "../../slots/task-coordinator-slots.js";
import { shellHistory } from "../../surface-realm-channel";
import {
  type AppsInventorySnapshot,
  AppsManagementSection,
} from "../settings/AppsManagementSection";
import { ViewHeader } from "../shared/ViewHeader";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

type ProjectLoadState =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; message: string };

const PROJECTS_ROUTE = "/apps/tasks";
const PROJECTS_ROUTE_ALIASES = new Set(["/apps/my-apps", "/cloud-apps"]);

const LAST_ACTIVITY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

const ProjectPublishPanel = lazy(() =>
  import("../../cloud/applications/components/project-publish-panel").then(
    (module) => ({ default: module.ProjectPublishPanel }),
  ),
);

function normalizedPath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] || "/";
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function readProjectIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const search = shouldUseHashNavigation()
    ? (window.location.hash.split("?", 2)[1] ?? "")
    : window.location.search;
  return new URLSearchParams(search).get("projectId");
}

function replaceProjectsAlias(): void {
  if (typeof window === "undefined") return;
  const current = normalizedPath(getWindowNavigationPath());
  if (!PROJECTS_ROUTE_ALIASES.has(current)) return;
  const projectId = readProjectIdFromLocation();
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const nextPath = `${PROJECTS_ROUTE}${query}`;
  if (shouldUseHashNavigation()) {
    shellHistory.replaceState(null, "", `#${nextPath}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    shellHistory.replaceState(null, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

function openProjectPath(projectId?: string): void {
  navigateBrowserPath(
    projectId
      ? `${PROJECTS_ROUTE}?projectId=${encodeURIComponent(projectId)}`
      : PROJECTS_ROUTE,
  );
}

/**
 * The package.json name projected by the project API is authoritative and must
 * match an installed package identifier exactly. Older hosts omit that derived
 * field, so their compatibility path compares normalized workspace names only;
 * display names never participate because they are neither stable nor unique.
 */
export function normalizeProjectPackageKey(value: string): string {
  const segment = value.trim().toLowerCase().split("/").filter(Boolean).at(-1);
  return (segment ?? "")
    .replace(/^(?:elizaos-|plugin-|app-)+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function findProjectPackage(
  project: ProjectSummary,
  installed: InstalledAppInfo[],
): InstalledAppInfo | null {
  const hasPackageProjection = Object.hasOwn(project, "packageName");
  const packageName = project.packageName;
  if (typeof packageName === "string" && packageName.trim().length > 0) {
    const canonicalPackageName = packageName.trim();
    return (
      installed.find(
        (app) =>
          app.name === canonicalPackageName ||
          app.pluginName === canonicalPackageName,
      ) ?? null
    );
  }
  if (hasPackageProjection) return null;

  const pathName =
    project.localPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const projectKeys = new Set(
    [project.name, pathName]
      .map(normalizeProjectPackageKey)
      .filter((value) => value.length > 0),
  );
  return (
    installed.find(
      (app) =>
        projectKeys.has(normalizeProjectPackageKey(app.name)) ||
        projectKeys.has(normalizeProjectPackageKey(app.pluginName)),
    ) ?? null
  );
}

function isLiveRun(run: AppRunSummary): boolean {
  return ![
    "stopped",
    "offline",
    "error",
    "failed",
    "completed",
    "exited",
  ].includes(run.status.toLowerCase());
}

function projectLastActivity(lastOpenedAt: string): string {
  const timestamp = Date.parse(lastOpenedAt);
  return Number.isFinite(timestamp)
    ? LAST_ACTIVITY_FORMATTER.format(timestamp)
    : "Activity unavailable";
}

function ProjectList({
  projects,
  loadState,
  inventory,
  activationError,
  busyProjectId,
  onOpen,
  onToggleRun,
  onRetry,
}: {
  projects: ProjectSummary[];
  loadState: ProjectLoadState;
  inventory: AppsInventorySnapshot | null;
  activationError: string | null;
  busyProjectId: string | null;
  onOpen: (projectId: string) => void;
  onToggleRun: (
    project: ProjectSummary,
    app: InstalledAppInfo,
    running: boolean,
  ) => void;
  onRetry: () => void;
}) {
  if (loadState.state === "loading") {
    return (
      <section aria-labelledby="projects-list-heading">
        <h2
          id="projects-list-heading"
          className="mb-2 text-sm font-semibold text-txt-strong"
        >
          Your projects
        </h2>
        <div className="space-y-2" role="status" aria-label="Loading projects">
          {[0, 1].map((item) => (
            <div
              key={item}
              className="h-16 animate-pulse rounded-md bg-bg-accent motion-reduce:animate-none"
            />
          ))}
        </div>
      </section>
    );
  }

  if (loadState.state === "error") {
    return (
      <section
        className="flex flex-wrap items-center justify-between gap-3 py-4"
        aria-labelledby="projects-list-heading"
      >
        <div>
          <h2
            id="projects-list-heading"
            className="text-sm font-semibold text-txt-strong"
          >
            Projects could not be loaded
          </h2>
          <p className="mt-1 text-sm text-danger" role="alert">
            {loadState.message}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 px-4"
          onClick={onRetry}
        >
          Retry
        </Button>
      </section>
    );
  }

  if (projects.length === 0) {
    return (
      <section
        className="py-6 text-center"
        aria-labelledby="projects-list-heading"
      >
        <FolderGit2 className="mx-auto mb-3 h-7 w-7 text-muted" aria-hidden />
        <h2
          id="projects-list-heading"
          className="text-sm font-semibold text-txt-strong"
        >
          Start your first project
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Describe what you want to build, or add a workspace you already have.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="projects-list-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2
          id="projects-list-heading"
          className="text-sm font-semibold text-txt-strong"
        >
          Your projects
        </h2>
        <span className="text-xs text-muted">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </span>
      </div>
      {activationError ? (
        <p className="mb-3 text-sm text-danger" role="alert">
          {activationError}
        </p>
      ) : null}
      <div className="divide-y divide-border/60 border-y border-border/60">
        {projects.map((project) => {
          const app = inventory
            ? findProjectPackage(project, inventory.installed)
            : null;
          const liveRuns =
            app && inventory
              ? inventory.runs.filter(
                  (run) => run.appName === app.name && isLiveRun(run),
                )
              : [];
          const running = liveRuns.length > 0;
          const busy = busyProjectId === project.id;
          return (
            <div
              key={project.id}
              className="group flex min-h-16 w-full items-center gap-1 py-1 transition-colors hover:bg-bg-hover/40"
              data-testid={`project-row-${project.id}`}
            >
              <button
                type="button"
                className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-1 text-left"
                aria-label={`Open ${project.name}`}
                disabled={busy}
                onClick={() => onOpen(project.id)}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-bg-accent text-muted group-hover:text-txt">
                  <FolderGit2 className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium text-txt-strong">
                      {project.name}
                    </span>
                    <ProjectPublicationBadge project={project} />
                    {running ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ok">
                        <span
                          className="h-2 w-2 rounded-full bg-ok"
                          aria-hidden
                        />
                        Running
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {project.repoUrl ?? project.localPath}
                  </span>
                </span>
                <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex">
                  <Clock3 className="h-3.5 w-3.5" aria-hidden />
                  {projectLastActivity(project.lastOpenedAt)}
                </span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted"
                  aria-hidden
                />
              </button>
              {app ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={
                    running
                      ? "min-h-11 min-w-11 shrink-0 px-3 text-danger hover:text-danger"
                      : "min-h-11 min-w-11 shrink-0 px-3"
                  }
                  disabled={busy}
                  aria-label={
                    running ? `Stop ${project.name}` : `Launch ${project.name}`
                  }
                  onClick={() => onToggleRun(project, app, running)}
                >
                  {running ? (
                    <Square className="h-4 w-4" aria-hidden />
                  ) : (
                    <Play className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProjectOverview({
  project,
  app,
  liveRuns,
  onShowActivity,
  onShowRun,
}: {
  project: ProjectSummary;
  app: InstalledAppInfo | null;
  liveRuns: AppRunSummary[];
  onShowActivity: () => void;
  onShowRun: () => void;
}) {
  return (
    <div className="space-y-5 py-2" data-testid="project-overview">
      <dl className="divide-y divide-border/60 border-y border-border/60 text-sm">
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-muted">Folder</dt>
          <dd className="break-all font-mono text-xs text-txt">
            {project.localPath}
          </dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-muted">Repository</dt>
          <dd className="break-all text-txt">
            {project.repoUrl ?? "Not connected"}
          </dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-muted">Last activity</dt>
          <dd className="text-txt">
            {projectLastActivity(project.lastOpenedAt)}
          </dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-muted">Run status</dt>
          <dd className="text-txt">
            {!app
              ? "No launchable package linked"
              : liveRuns.length > 0
                ? `${liveRuns.length} active ${liveRuns.length === 1 ? "run" : "runs"}`
                : "Ready to launch"}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 px-4"
          onClick={onShowActivity}
        >
          <Activity className="mr-2 h-4 w-4" aria-hidden />
          View activity
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 px-4"
          onClick={onShowRun}
        >
          <Play className="mr-2 h-4 w-4" aria-hidden />
          Open Run
        </Button>
      </div>
      <section
        className="min-h-64 overflow-hidden border border-border/60"
        aria-label="Recent coding activity"
      >
        <CodingAgentTasksPanel projectId={project.id} limit={4} />
      </section>
    </div>
  );
}

function ProjectDetail({
  project,
  inventory,
  onBack,
  onInventoryChange,
  onProjectChanged,
  activationError,
}: {
  project: ProjectSummary;
  inventory: AppsInventorySnapshot | null;
  onBack: () => void;
  onInventoryChange: (snapshot: AppsInventorySnapshot) => void;
  onProjectChanged: (project: ProjectSummary) => void;
  activationError: string | null;
}) {
  const [tab, setTab] = useState("overview");
  const app = inventory
    ? findProjectPackage(project, inventory.installed)
    : null;
  const liveRuns =
    app && inventory
      ? inventory.runs.filter(
          (run) => run.appName === app.name && isLiveRun(run),
        )
      : [];
  const includedAppNames = useMemo(() => new Set(app ? [app.name] : []), [app]);

  return (
    <>
      <ViewHeader
        title={project.name}
        onBack={onBack}
        backLabel="Back to Projects"
      />
      <div
        className="eliza-chat-scroll min-h-0 flex-1 overflow-y-auto pb-[var(--eliza-chat-clearance,5.25rem)]"
        data-scroll-cert-scroller
      >
        <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
          {activationError ? (
            <p className="mb-4 text-sm text-danger" role="alert">
              {activationError}
            </p>
          ) : null}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList
              className="grid h-11 w-full grid-cols-4 sm:w-auto"
              aria-label="Project sections"
            >
              <TabsTrigger value="overview" className="min-h-9">
                Overview
              </TabsTrigger>
              <TabsTrigger value="activity" className="min-h-9">
                Activity
              </TabsTrigger>
              <TabsTrigger value="run" className="min-h-9">
                Run
              </TabsTrigger>
              <TabsTrigger value="publish" className="min-h-9">
                Publish
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <ProjectOverview
                project={project}
                app={app}
                liveRuns={liveRuns}
                onShowActivity={() => setTab("activity")}
                onShowRun={() => setTab("run")}
              />
            </TabsContent>
            <TabsContent value="activity" className="min-h-64">
              <CodingAgentTasksPanel fullPage projectId={project.id} />
            </TabsContent>
            <TabsContent value="run">
              <AppsManagementSection
                inventoryOnly
                inventoryVariant="compact"
                includedAppNames={includedAppNames}
                inventoryTitle="Run"
                inventoryEmptyMessage="No launchable package is linked to this project yet."
                onInventoryChange={onInventoryChange}
              />
            </TabsContent>
            <TabsContent value="publish">
              <Suspense
                fallback={
                  <div
                    className="flex min-h-52 items-center justify-center text-sm text-muted"
                    role="status"
                    data-view-status="loading"
                  >
                    Loading publishing tools…
                  </div>
                }
              >
                <ProjectPublishPanel
                  project={project}
                  onProjectChanged={onProjectChanged}
                />
              </Suspense>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}

export function TasksPageView() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<ProjectLoadState>({
    state: "loading",
  });
  const [selectedProjectId, setSelectedProjectId] = useState(
    readProjectIdFromLocation,
  );
  const [inventory, setInventory] = useState<AppsInventorySnapshot | null>(
    null,
  );
  const [activationError, setActivationError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const activationRequestedRef = useRef<string | null>(null);

  const refreshProjects = useCallback(async (silent = false) => {
    if (!silent) setLoadState({ state: "loading" });
    try {
      const response = await client.listProjects();
      setProjects(response.projects);
      setLoadState({ state: "ready" });
    } catch (error) {
      // error-policy:J4 a registry failure must render differently from an
      // intentional empty registry, including during background refresh.
      setLoadState({
        state: "error",
        message:
          error instanceof Error ? error.message : "Failed to load projects.",
      });
    }
  }, []);

  useEffect(() => {
    replaceProjectsAlias();
    const syncSelection = () =>
      setSelectedProjectId(readProjectIdFromLocation());
    syncSelection();
    window.addEventListener("popstate", syncSelection);
    window.addEventListener("hashchange", syncSelection);
    return () => {
      window.removeEventListener("popstate", syncSelection);
      window.removeEventListener("hashchange", syncSelection);
    };
  }, []);

  useEffect(() => {
    void refreshProjects();
    const timer = window.setInterval(() => void refreshProjects(true), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshProjects]);

  const projectPackages = useMemo(() => {
    const map = new Map<string, InstalledAppInfo>();
    if (!inventory) return map;
    for (const project of projects) {
      const app = findProjectPackage(project, inventory.installed);
      if (app) map.set(project.id, app);
    }
    return map;
  }, [inventory, projects]);

  const excludedAppNames = useMemo(
    () => new Set([...projectPackages.values()].map((app) => app.name)),
    [projectPackages],
  );

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;
  const handleProjectChanged = useCallback((nextProject: ProjectSummary) => {
    setProjects((current) =>
      current.map((project) =>
        project.id === nextProject.id ? nextProject : project,
      ),
    );
  }, []);

  const activateAndOpenProject = useCallback(
    async (projectId: string) => {
      setActivationError(null);
      setBusyProjectId(projectId);
      activationRequestedRef.current = projectId;
      try {
        const next = await client.activateProject(projectId);
        handleProjectChanged(next);
        openProjectPath(next.id);
      } catch (error) {
        activationRequestedRef.current = null;
        setActivationError(
          error instanceof Error
            ? error.message
            : "Could not activate this project.",
        );
      } finally {
        setBusyProjectId(null);
      }
    },
    [handleProjectChanged],
  );

  useEffect(() => {
    if (!selectedProjectId) {
      activationRequestedRef.current = null;
      setActivationError(null);
      return;
    }
    if (
      loadState.state !== "ready" ||
      !selectedProject ||
      activationRequestedRef.current === selectedProjectId
    ) {
      return;
    }
    activationRequestedRef.current = selectedProjectId;
    void client
      .activateProject(selectedProjectId)
      .then((next) => {
        handleProjectChanged(next);
        setActivationError(null);
      })
      .catch((error: unknown) => {
        activationRequestedRef.current = null;
        setActivationError(
          error instanceof Error
            ? error.message
            : "Could not activate this project.",
        );
      });
  }, [
    handleProjectChanged,
    loadState.state,
    selectedProject,
    selectedProjectId,
  ]);

  const handleToggleProjectRun = useCallback(
    async (
      project: ProjectSummary,
      app: InstalledAppInfo,
      running: boolean,
    ) => {
      setActivationError(null);
      setBusyProjectId(project.id);
      try {
        if (running) {
          const result = await client.stopApp(app.name);
          if (!result.success) {
            throw new Error(
              result.message ?? `Could not stop ${project.name}.`,
            );
          }
        } else {
          await client.launchApp(app.name);
        }
        const [installed, runs] = await Promise.all([
          client.listInstalledApps(),
          client.listAppRuns(),
        ]);
        setInventory({ installed, runs });
      } catch (error) {
        setActivationError(
          error instanceof Error
            ? error.message
            : `Could not ${running ? "stop" : "launch"} ${project.name}.`,
        );
      } finally {
        setBusyProjectId(null);
      }
    },
    [],
  );

  const handleProjectsChanged = useCallback(
    async (projectId?: string) => {
      await refreshProjects();
      if (projectId) await activateAndOpenProject(projectId);
    },
    [activateAndOpenProject, refreshProjects],
  );

  return (
    <ShellViewAgentSurface viewId="tasks">
      <div
        className="flex h-full min-h-0 w-full flex-col"
        data-testid="tasks-view"
      >
        {selectedProject ? (
          <ProjectDetail
            project={selectedProject}
            inventory={inventory}
            onBack={() => openProjectPath()}
            onInventoryChange={setInventory}
            onProjectChanged={handleProjectChanged}
            activationError={activationError}
          />
        ) : selectedProjectId && loadState.state === "ready" ? (
          <>
            <ViewHeader
              title="Project unavailable"
              onBack={() => openProjectPath()}
              backLabel="Back to Projects"
            />
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
              <div>
                <p role="alert" className="text-sm text-txt">
                  This project is no longer in your local registry.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4 min-h-11 px-4"
                  onClick={() => openProjectPath()}
                >
                  Back to Projects
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <ViewHeader title="Projects" />
            <div
              className="eliza-chat-scroll min-h-0 flex-1 overflow-y-auto pb-[var(--eliza-chat-clearance,5.25rem)]"
              data-scroll-cert-scroller
            >
              <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
                <AppsManagementSection
                  inventoryVariant="compact"
                  excludedAppNames={excludedAppNames}
                  inventoryTitle="Installed"
                  inventoryEmptyMessage="No other installed packages."
                  actionsTitle="Start"
                  showAdvancedToggle={false}
                  onInventoryChange={setInventory}
                  onProjectsChanged={handleProjectsChanged}
                >
                  <ProjectList
                    projects={projects}
                    loadState={loadState}
                    inventory={inventory}
                    activationError={activationError}
                    busyProjectId={busyProjectId}
                    onOpen={(projectId) =>
                      void activateAndOpenProject(projectId)
                    }
                    onToggleRun={(project, app, running) =>
                      void handleToggleProjectRun(project, app, running)
                    }
                    onRetry={() => void refreshProjects()}
                  />
                </AppsManagementSection>
              </div>
            </div>
          </>
        )}
      </div>
    </ShellViewAgentSurface>
  );
}
