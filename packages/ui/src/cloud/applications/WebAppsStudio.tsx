/**
 * Web app-shell Applications routes preserve the host's navigation lifecycle
 * and cloud providers across the list, detail, and deployment tabs.
 */
import { lazy } from "react";
import { Route, Routes } from "react-router-dom";
import ApplicationsPage from "./ApplicationsPage";

const ApplicationDetailPage = lazy(() => import("./ApplicationDetailPage"));

export default function WebAppsStudio(): React.JSX.Element {
  return (
    <div className="theme-cloud flex h-full min-h-0 w-full flex-col overflow-y-auto bg-surface text-txt">
      <Routes>
        <Route path="/cloud-apps" element={<ApplicationsPage />} />
        <Route path="/cloud-apps/:id" element={<ApplicationDetailPage />} />
      </Routes>
    </div>
  );
}
