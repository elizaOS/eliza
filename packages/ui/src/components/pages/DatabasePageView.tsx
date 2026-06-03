import type { ReactNode } from "react";
import { lazy, Suspense } from "react";
import { useAgentElement } from "../../agent-surface";
import { useApp } from "../../state";
import { SegmentedControl } from "../ui/segmented-control";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { DatabaseView } from "./DatabaseView";
import { MediaGalleryView } from "./MediaGalleryView";

// VectorBrowserView is a heavy three.js (WebGL) surface and pulls the injected
// THREE runtime. It lives in its own plugin package and is loaded dynamically
// so it (and three) only ship when the user actually opens the vectors tab,
// never with the always-loaded Database page.
const VectorBrowserView = lazy(async () => ({
  default: (await import("@elizaos/plugin-vector-browser")).VectorBrowserView,
}));

// The SegmentedControl is a composite that renders its own internal buttons and
// does not forward refs to them, so each tab registers with the agent surface
// through a tiny ref-less child that drives selection via onActivate (mirrors
// SettingsNavButton in SettingsView.tsx).
function DatabaseTabButton({
  id,
  label,
  isActive,
  onSelect,
}: {
  id: "tables" | "media" | "vectors";
  label: string;
  isActive: boolean;
  onSelect: (id: "tables" | "media" | "vectors") => void;
}) {
  useAgentElement({
    id: `tab-${id}`,
    role: "tab",
    label,
    group: "database-views",
    status: isActive ? "active" : "inactive",
    description: `Switch to the ${label} database view`,
    onActivate: () => onSelect(id),
  });
  return null;
}

export function DatabasePageView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const { t, databaseSubTab, setState } = useApp();
  const dbTabs = [
    {
      id: "tables" as const,
      label: t("databaseview.Tables"),
    },
    {
      id: "media" as const,
      label: t("mediagalleryview.Media"),
    },
    {
      id: "vectors" as const,
      label: t("common.vectors"),
    },
  ];

  const selectTab = (v: "tables" | "media" | "vectors") =>
    setState("databaseSubTab", v);

  const leftNav = (
    <>
      <SegmentedControl
        value={databaseSubTab}
        onValueChange={selectTab}
        items={dbTabs.map((tab) => ({ value: tab.id, label: tab.label }))}
        role="tablist"
        aria-label={t("aria.databaseViews")}
      />
      {dbTabs.map((tab) => (
        <DatabaseTabButton
          key={tab.id}
          id={tab.id}
          label={tab.label}
          isActive={databaseSubTab === tab.id}
          onSelect={selectTab}
        />
      ))}
    </>
  );

  // Each sub-view owns its own PageLayout + Sidebar.
  // contentHeader and leftNav are passed through so the layout is uniform.
  if (databaseSubTab === "media") {
    return (
      <ShellViewAgentSurface viewId="database">
        <MediaGalleryView leftNav={leftNav} contentHeader={contentHeader} />
      </ShellViewAgentSurface>
    );
  }
  if (databaseSubTab === "vectors") {
    return (
      <ShellViewAgentSurface viewId="database">
        <Suspense
          fallback={
            <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
              {t("common.loading", { defaultValue: "Loading…" })}
            </div>
          }
        >
          <VectorBrowserView leftNav={leftNav} contentHeader={contentHeader} />
        </Suspense>
      </ShellViewAgentSurface>
    );
  }
  return (
    <ShellViewAgentSurface viewId="database">
      <DatabaseView leftNav={leftNav} contentHeader={contentHeader} />
    </ShellViewAgentSurface>
  );
}
