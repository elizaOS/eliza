/**
 * My Apps — the standalone view for managing installed elizaOS apps: the running
 * inventory (start/stop/restart), plus the "Create new app" and "Load from
 * directory" entry points. This is the same surface that used to live only as a
 * hidden Settings tab; it now has its own launcher tile so app management is a
 * first-class destination rather than buried in preferences. The body is the
 * reused {@link AppsManagementSection}, wrapped in a titled scroll page.
 */

import { AppsManagementSection } from "../settings/AppsManagementSection";
import { ViewHeader } from "../shared/ViewHeader";

export function MyAppsView() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ViewHeader title="My Apps" />
      <div className="min-h-0 flex-1 overflow-y-auto eliza-continuous-chat-scroll pb-[var(--eliza-continuous-chat-clearance,5.25rem)]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
          <p className="text-sm text-muted">
            Install, create, and run your elizaOS apps.
          </p>
          <AppsManagementSection />
        </div>
      </div>
    </div>
  );
}
