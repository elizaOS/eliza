/**
 * My Apps — the standalone view for managing elizaOS apps: the running
 * inventory (start/stop/restart), the "Create new app" and "Load from
 * directory" entry points, and — when this build registers the native Cloud
 * Applications studio and the user is signed into Eliza Cloud — the row that
 * opens that studio. My Apps is the launcher's ONE apps destination: the
 * studio deliberately has no launcher tile of its own (`LAUNCHER_HIDDEN_IDS`
 * in launcher-curation), so everything the old "Apps" tile offered is reached
 * from here (or by the /cloud-apps deep link). The body is the reused
 * {@link AppsManagementSection}, wrapped in a titled scroll page.
 */

import { Cloud } from "lucide-react";
import { useSyncExternalStore } from "react";
import { navigateBrowserPath } from "../../app-navigate-view";
import {
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  subscribeAppShellPages,
} from "../../app-shell-registry";
import { useAppSelector } from "../../state";
import { AppsManagementSection } from "../settings/AppsManagementSection";
import { SettingsGroup, SettingsRow } from "../settings/settings-layout";
import { ViewHeader } from "../shared/ViewHeader";

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

export function MyAppsView() {
  const cloudStudioPath = useCloudAppsStudioPath();
  const cloudConnected = useAppSelector((state) => state.elizaCloudConnected);
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ViewHeader
        title={
          <span className="text-2xl font-extrabold tracking-normal text-txt-strong">
            My Apps
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto eliza-chat-scroll pb-[var(--eliza-chat-clearance,5.25rem)]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
          <p className="text-sm text-muted">
            Install, create, and run your elizaOS apps.
          </p>
          <AppsManagementSection />
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
                buttonProps={{ "data-testid": "my-apps-cloud-studio-row" }}
              />
            </SettingsGroup>
          ) : null}
        </div>
      </div>
    </div>
  );
}
