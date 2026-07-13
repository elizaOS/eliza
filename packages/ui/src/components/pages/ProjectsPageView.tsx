import {
  CheckCircle2,
  Cloud,
  CloudUpload,
  FolderGit2,
  Loader2,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api/client";
import type {
  CodingAgentTaskThread,
  ProjectSummary,
} from "../../api/client-types-cloud";
import { CodingAgentTasksPanel } from "../../slots/task-coordinator-slots";
import { useAppSelector } from "../../state";
import { ViewHeader } from "../shared/ViewHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

type ProjectSelection = string | "unassigned" | null;

function projectNameFromPath(localPath: string): string {
  const parts = localPath
    .trim()
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/);
  return parts.at(-1) || "Project";
}

function isPublishTask(task: CodingAgentTaskThread): boolean {
  return /\b(publish|deploy|release|ship)\b/i.test(
    `${task.title} ${task.originalRequest}`,
  );
}

function projectStatus(
  project: ProjectSummary,
  tasks: CodingAgentTaskThread[],
): { label: string; active: boolean } {
  const publishing = tasks.some(
    (task) =>
      task.projectId === project.id &&
      isPublishTask(task) &&
      !["done", "failed", "archived", "interrupted"].includes(task.status),
  );
  if (publishing) return { label: "Publishing", active: true };
  if (project.cloudAppId) return { label: "Cloud", active: false };
  return { label: "Local", active: false };
}

function ProjectCard({
  project,
  tasks,
  active,
  onOpen,
}: {
  project: ProjectSummary;
  tasks: CodingAgentTaskThread[];
  active: boolean;
  onOpen: () => void;
}) {
  const taskCount = tasks.filter(
    (task) => task.projectId === project.id,
  ).length;
  const status = projectStatus(project, tasks);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-2xl border border-border/50 bg-card/80 p-4 text-left transition-colors hover:bg-surface"
      data-testid={`project-card-${project.id}`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-accent text-muted-strong">
        <FolderGit2 className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-txt-strong">
            {project.name}
          </span>
          {active ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {project.localPath}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
        <span>{taskCount}</span>
        <span
          className={
            status.active
              ? "rounded-full bg-accent-subtle px-2 py-1 text-accent"
              : "rounded-full bg-bg-accent px-2 py-1"
          }
        >
          {status.label}
        </span>
      </span>
    </button>
  );
}

export function ProjectsPageView() {
  const setActionNotice = useAppSelector((state) => state.setActionNotice);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CodingAgentTaskThread[]>([]);
  const [selection, setSelection] = useState<ProjectSelection>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [projectList, taskList] = await Promise.all([
        client.listProjects(),
        client
          .listCodingAgentTaskThreads({ includeArchived: false, limit: 200 })
          .catch(() => []),
      ]);
      setProjects(projectList.projects);
      setActiveProjectId(projectList.activeProjectId);
      setTasks(taskList);
    } catch (error) {
      setActionNotice(
        error instanceof Error ? error.message : "Couldn't load projects.",
        "error",
        5000,
      );
    } finally {
      setLoading(false);
    }
  }, [setActionNotice]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selection) ?? null,
    [projects, selection],
  );
  const unassignedCount = tasks.filter(
    (task) => task.projectId === null,
  ).length;

  const openProject = useCallback(
    async (project: ProjectSummary) => {
      setSelection(project.id);
      setActiveProjectId(project.id);
      try {
        await client.activateProject(project.id);
      } catch (error) {
        setActionNotice(
          error instanceof Error
            ? error.message
            : "Couldn't activate this project.",
          "error",
          5000,
        );
      }
    },
    [setActionNotice],
  );

  const createProject = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const path = localPath.trim();
      if (!path || saving) return;
      setSaving(true);
      try {
        const project = await client.createProject({
          name: name.trim() || projectNameFromPath(path),
          localPath: path,
        });
        setName("");
        setLocalPath("");
        setShowCreate(false);
        await refresh();
        setSelection(project.id);
      } catch (error) {
        setActionNotice(
          error instanceof Error ? error.message : "Couldn't add project.",
          "error",
          5000,
        );
      } finally {
        setSaving(false);
      }
    },
    [localPath, name, refresh, saving, setActionNotice],
  );

  const publishProject = useCallback(async () => {
    if (!selectedProject || publishing) return;
    setPublishing(true);
    try {
      await client.createOrchestratorTask({
        title: `Publish ${selectedProject.name}`,
        goal: selectedProject.cloudAppId
          ? `Publish the latest verified version of ${selectedProject.name} to its existing Eliza Cloud app ${selectedProject.cloudAppId}. Verify the live deployment before finishing.`
          : `Publish ${selectedProject.name} to Eliza Cloud. Create the Cloud app, bind it to this project, deploy it, and verify the live deployment before finishing.`,
        originalRequest: `Publish ${selectedProject.name}`,
        kind: "coding",
        priority: "high",
        projectId: selectedProject.id,
        workdir: selectedProject.localPath,
        metadata: {
          autoVerify: true,
          capabilityProfile: "economics",
          publishProject: true,
        },
      });
      setActionNotice("Publishing task started.", "success", 3500);
      await refresh();
    } catch (error) {
      setActionNotice(
        error instanceof Error ? error.message : "Couldn't start publishing.",
        "error",
        5000,
      );
    } finally {
      setPublishing(false);
    }
  }, [publishing, refresh, selectedProject, setActionNotice]);

  if (showCreate) {
    return (
      <ShellViewAgentSurface viewId="projects">
        <div className="flex h-full min-h-0 w-full flex-col">
          <ViewHeader
            title="New project"
            onBack={() => setShowCreate(false)}
            backLabel="Back to Projects"
          />
          <form
            onSubmit={createProject}
            className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 pt-4"
          >
            <Input
              value={localPath}
              onChange={(event) => setLocalPath(event.target.value)}
              placeholder="Project folder"
              aria-label="Project folder"
              autoFocus
            />
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name (optional)"
              aria-label="Project name"
            />
            <Button type="submit" disabled={!localPath.trim() || saving}>
              {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Add project
            </Button>
          </form>
        </div>
      </ShellViewAgentSurface>
    );
  }

  if (selection === "unassigned" || selectedProject) {
    const title = selectedProject?.name ?? "Unassigned";
    return (
      <ShellViewAgentSurface viewId="projects">
        <div className="flex h-full min-h-0 w-full flex-col">
          <ViewHeader
            title={title}
            onBack={() => setSelection(null)}
            backLabel="Back to Projects"
            right={
              selectedProject ? (
                <Button
                  size="sm"
                  onClick={() => void publishProject()}
                  disabled={publishing}
                  aria-label={`Publish ${selectedProject.name}`}
                >
                  {publishing ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : selectedProject.cloudAppId ? (
                    <CloudUpload aria-hidden />
                  ) : (
                    <Cloud aria-hidden />
                  )}
                  <span className="hidden sm:inline">Publish</span>
                </Button>
              ) : null
            }
          />
          <div className="device-layout mx-auto flex min-h-0 w-full min-w-0 max-w-4xl flex-1 flex-col">
            <CodingAgentTasksPanel
              fullPage
              projectId={selectedProject?.id ?? null}
            />
          </div>
        </div>
      </ShellViewAgentSurface>
    );
  }

  return (
    <ShellViewAgentSurface viewId="projects">
      <div
        className="flex h-full min-h-0 w-full flex-col"
        data-testid="projects-view"
      >
        <ViewHeader
          title="Projects"
          right={
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowCreate(true)}
              aria-label="Add project"
            >
              <Plus aria-hidden />
            </Button>
          }
        />
        <div className="eliza-continuous-chat-scroll min-h-0 flex-1 overflow-y-auto pb-[var(--eliza-continuous-chat-clearance,5.25rem)]">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
            {loading ? (
              <div className="flex justify-center py-10 text-muted">
                <Loader2
                  className="animate-spin"
                  aria-label="Loading projects"
                />
              </div>
            ) : null}
            {!loading && projects.length === 0 && unassignedCount === 0 ? (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border/70 px-4 py-10 text-sm text-muted transition-colors hover:bg-surface hover:text-txt"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add project
              </button>
            ) : null}
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                tasks={tasks}
                active={project.id === activeProjectId}
                onOpen={() => void openProject(project)}
              />
            ))}
            {unassignedCount > 0 ? (
              <button
                type="button"
                onClick={() => setSelection("unassigned")}
                className="flex w-full items-center gap-3 rounded-2xl border border-border/50 bg-card/80 p-4 text-left transition-colors hover:bg-surface"
                data-testid="project-card-unassigned"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-accent text-muted-strong">
                  <CheckCircle2 className="h-5 w-5" aria-hidden />
                </span>
                <span className="flex-1 text-sm font-semibold text-txt-strong">
                  Unassigned
                </span>
                <span className="text-xs text-muted">{unassignedCount}</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
