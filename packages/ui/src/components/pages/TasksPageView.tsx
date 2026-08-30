/**
 * Projects — the ONE consolidated projects/apps surface (tab id `tasks`, route
 * `/apps/tasks`, #17031). A segmented control under the shared `ViewHeader`
 * switches between the coding-agent task coordinator ("Tasks") and the app
 * inventory ("Apps": create/load/run controls plus, on cloud-signed-in native
 * builds, the Eliza Cloud Applications studio row). The standalone My Apps
 * view/route/tile is retired; its old deep links (`/apps`, `/apps/my-apps`)
 * resolve here with the Apps segment pre-selected.
 *
 * The shell header owns the back affordance and the title, so the task panel is
 * mounted in its `fullPage` mode with its own internal title row suppressed —
 * one header per view, no duplication.
 */
import { Cloud } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAgentElement } from "../../agent-surface";
import { navigateBrowserPath } from "../../app-navigate-view";
import {
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  subscribeAppShellPages,
} from "../../app-shell-registry";
import { dispatchChatClose } from "../../events";
import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
  FramedPageNavigation,
} from "../../layouts/framed-page";
import { getWindowNavigationPath } from "../../navigation";
import { CodingAgentTasksPanel } from "../../slots/task-coordinator-slots.js";
import { useAppSelector } from "../../state";
import {
  AppsManagementActions,
  AppsManagementSection,
} from "../settings/AppsManagementSection";
import { SettingsGroup, SettingsRow } from "../settings/settings-layout";
import { useShellControllerContext } from "../shell/ShellControllerContext.hooks";
import { SegmentedControl } from "../ui/segmented-control";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

type ProjectsSegment = "tasks" | "apps";

/**
 * Route of the registered Cloud Applications studio page (`cloud-apps`), or
 * null when this build has none. Only native shells register the page (the web
 * build serves the Applications surfaces through `CloudRouterShell`), so
 * presence doubles as the platform gate for the studio row.
 */
function useCloudAppsStudioPath(): string | null {
  // Subscribing to the registry version re-renders this view when the page
  // registers after mount (the host registers it at boot, views can mount
  // earlier); the path itself is re-read from the registry below.
  useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
  return (
    listAppShellPages().find((page) => page.id === "cloud-apps")?.path ?? null
  );
}

/**
 * Pick the initially shown segment from the mount-time URL so the retired My
 * Apps deep links (`/apps` bare and the `/apps/my-apps` app-window path) open
 * directly on the Apps segment. `/apps/tasks` — and every other entry into the
 * tab — leads with Tasks.
 */
export function initialProjectsSegmentForPath(
  pathname: string,
): ProjectsSegment {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  return normalized.endsWith("/apps") || normalized.endsWith("/apps/my-apps")
    ? "apps"
    : "tasks";
}

// The SegmentedControl composite renders its own internal buttons and does not
// forward refs, so each segment registers with the agent surface through a
// ref-less child driving selection via onActivate (mirrors DatabasePageView).
function ProjectsSegmentButton({
  id,
  label,
  isActive,
  onSelect,
}: {
  id: ProjectsSegment;
  label: string;
  isActive: boolean;
  onSelect: (id: ProjectsSegment) => void;
}) {
  const elementId = `projects-segment-${id}`;
  useAgentElement({
    id: elementId,
    role: "tab",
    label,
    group: "projects-segments",
    status: isActive ? "active" : "inactive",
    description: `Switch to the ${label} projects segment`,
    onActivate: () => onSelect(id),
  });
  return null;
}

/**
 * The Projects nav tab. The shared `ViewHeader` supplies the uniform top bar;
 * the segmented control switches the body between the coding-agent task panel
 * (`fullPage`, no second heading) and the app inventory.
 */
export function TasksPageView() {
  const shellController = useShellControllerContext();
  const [segment, setSegment] = useState<ProjectsSegment>(() =>
    initialProjectsSegmentForPath(
      typeof window === "undefined" ? "" : getWindowNavigationPath(),
    ),
  );
  const [showCreate, setShowCreate] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const cloudStudioPath = useCloudAppsStudioPath();
  const cloudConnected = useAppSelector((state) => state.elizaCloudConnected);
  const segments: Array<{ id: ProjectsSegment; label: string }> = [
    { id: "tasks", label: "Tasks" },
    { id: "apps", label: "Apps" },
  ];

  useEffect(() => {
    if (typeof window === "undefined") return;
    const selectSegmentForRoute = () => {
      setSegment(initialProjectsSegmentForPath(getWindowNavigationPath()));
    };
    window.addEventListener("hashchange", selectSegmentForRoute);
    window.addEventListener("popstate", selectSegmentForRoute);
    return () => {
      window.removeEventListener("hashchange", selectSegmentForRoute);
      window.removeEventListener("popstate", selectSegmentForRoute);
    };
  }, []);
  useEffect(() => {
    // App lifecycle controls must never sit underneath the ambient chat sheet.
    // Selecting the Apps segment therefore folds chat to its resting composer,
    // matching other control-heavy management surfaces and keeping every
    // create/load/run affordance reachable on phone, tablet, and desktop.
    if (segment === "apps") {
      dispatchChatClose();
      if (shellController?.isOpen) shellController.close();
    }
  }, [segment, shellController]);
  const segmentControl = (
    <>
      <SegmentedControl
        value={segment}
        onValueChange={setSegment}
        items={segments.map((entry) => ({
          value: entry.id,
          label: entry.label,
          testId: `projects-segment-${entry.id}`,
        }))}
        role="tablist"
        aria-label="Projects sections"
      />
      {segments.map((entry) => (
        <ProjectsSegmentButton
          key={entry.id}
          id={entry.id}
          label={entry.label}
          isActive={segment === entry.id}
          onSelect={setSegment}
        />
      ))}
    </>
  );
  return (
    <ShellViewAgentSurface viewId="tasks">
      <FramedPage gutterOwner="framed-page" data-testid="tasks-view">
        <FramedPageHeader title="Projects" />
        <FramedPageNavigation className="flex items-center justify-between gap-2">
          {segmentControl}
          {segment === "apps" ? (
            <AppsManagementActions
              showCreate={showCreate}
              showLoad={showLoad}
              setShowCreate={setShowCreate}
              setShowLoad={setShowLoad}
            />
          ) : null}
        </FramedPageNavigation>
        <FramedPageBody scroll="view" padded={false} className="device-layout">
          {segment === "apps" ? (
            <div
              className="min-h-0 flex-1 overflow-y-auto eliza-chat-scroll"
              data-testid="projects-apps-segment"
            >
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
                <AppsManagementSection
                  showCreate={showCreate}
                  showLoad={showLoad}
                  setShowCreate={setShowCreate}
                  setShowLoad={setShowLoad}
                  hideActions
                />
                {cloudStudioPath && cloudConnected ? (
                  // Same signed-in gate the launcher applies to cloud surfaces
                  // (LAUNCHER_CLOUD_IDS): the studio is useless without a cloud
                  // session, and sign-in lives upstream in Settings → Eliza Cloud.
                  <SettingsGroup title="Eliza Cloud">
                    <SettingsRow
                      icon={Cloud}
                      label="Cloud Apps"
                      description="Manage, deploy, and monetize your apps published on Eliza Cloud."
                      onClick={() => navigateBrowserPath(cloudStudioPath)}
                      buttonProps={{
                        "data-testid": "my-apps-cloud-studio-row",
                      }}
                    />
                  </SettingsGroup>
                ) : null}
              </div>
            </div>
          ) : (
            <CodingAgentTasksPanel fullPage />
          )}
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}
