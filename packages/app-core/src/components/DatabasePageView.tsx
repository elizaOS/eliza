/**
 * Databases page — wrapper with Tables / Media / Vectors sub-tabs.
 */

import { useApp } from "../state";
import { DatabaseView } from "./DatabaseView";
import { MediaGalleryView } from "./MediaGalleryView";
import { VectorBrowserView } from "./VectorBrowserView";

export function DatabasePageView() {
  const { t, databaseSubTab, setState } = useApp();
  const dbTabs = [
    {
      id: "tables" as const,
      label: t("databasepageview.Tables"),
    },
    {
      id: "media" as const,
      label: t("databasepageview.Media"),
    },
    {
      id: "vectors" as const,
      label: t("databasepageview.Vectors"),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b border-[var(--border)] mb-5">
        {dbTabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            className={`px-4 py-2 text-[13px] bg-transparent border-0 border-b-2 cursor-pointer transition-colors ${
              databaseSubTab === tab.id
                ? "text-[var(--accent)] font-medium border-b-[var(--accent)]"
                : "text-[var(--muted)] border-b-transparent hover:text-[var(--txt)]"
            }`}
            onClick={() => setState("databaseSubTab", tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 min-h-0">
        {databaseSubTab === "tables" && <DatabaseView />}
        {databaseSubTab === "media" && <MediaGalleryView />}
        {databaseSubTab === "vectors" && <VectorBrowserView />}
      </div>
    </div>
  );
}
