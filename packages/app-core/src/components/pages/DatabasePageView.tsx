import { SegmentedControl } from "@elizaos/ui";
import type { ReactNode } from "react";
import { useApp } from "../../state";
import { DatabaseView } from "./DatabaseView";
import { MediaGalleryView } from "./MediaGalleryView";
import { VectorBrowserView } from "./VectorBrowserView";

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

  const leftNav = (
    <SegmentedControl
      value={databaseSubTab}
      onValueChange={(v) => setState("databaseSubTab", v)}
      items={dbTabs.map((tab) => ({ value: tab.id, label: tab.label }))}
      role="tablist"
      aria-label={t("aria.databaseViews")}
    />
  );

  // Each sub-view owns its own PageLayout + Sidebar.
  // contentHeader and leftNav are passed through so the layout is uniform.
  if (databaseSubTab === "media") {
    return <MediaGalleryView leftNav={leftNav} contentHeader={contentHeader} />;
  }
  if (databaseSubTab === "vectors") {
    return (
      <VectorBrowserView leftNav={leftNav} contentHeader={contentHeader} />
    );
  }
  return <DatabaseView leftNav={leftNav} contentHeader={contentHeader} />;
}
