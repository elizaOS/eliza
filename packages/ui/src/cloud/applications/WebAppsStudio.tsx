/**
 * Web app-shell mount for Cloud Applications that preserves the host's
 * navigate-view lifecycle while supplying the cloud surface theme.
 */

import ApplicationsPage from "./ApplicationsPage";

/** Render the Applications list inside the web tab/view app catch-all. */
export default function WebAppsStudio(): React.JSX.Element {
  return (
    <div className="theme-cloud flex h-full min-h-0 w-full flex-col overflow-y-auto bg-surface text-txt">
      <ApplicationsPage />
    </div>
  );
}
