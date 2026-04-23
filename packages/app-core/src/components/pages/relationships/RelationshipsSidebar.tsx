import {
  Button,
  MetaPill,
  PagePanel,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import type { RelationshipsGraphSnapshot } from "../../../api/client-types-relationships";
import { AppPageSidebar } from "../../shared/AppPageSidebar";
import {
  RELATIONSHIPS_TOOLBAR_BUTTON_CLASS,
  summarizeHandles,
} from "./relationships-utils";

export function RelationshipsSidebar({
  search,
  platform,
  platforms,
  graph,
  graphLoading,
  selectedPersonId,
  onSearchChange,
  onSearchClear,
  onPlatformChange,
  onRefreshGraph,
  onSelectPersonId,
}: {
  search: string;
  platform: string;
  platforms: string[];
  graph: RelationshipsGraphSnapshot | null;
  graphLoading: boolean;
  selectedPersonId: string | null;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  onPlatformChange: (platform: string) => void;
  onRefreshGraph: () => void;
  onSelectPersonId: (personId: string) => void;
}) {
  return (
    <AppPageSidebar
      testId="relationships-sidebar"
      collapsible
      contentIdentity="relationships"
    >
      <SidebarHeader
        search={{
          value: search,
          onChange: (event) => onSearchChange(event.target.value),
          placeholder: "Search people, aliases, handles",
          "aria-label": "Search people, aliases, handles",
          onClear: onSearchClear,
        }}
      />
      <SidebarPanel>
        <PagePanel.SummaryCard compact className="mt-2 space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                People
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {graph?.stats.totalPeople ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Links
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {graph?.stats.totalRelationships ?? 0}
              </div>
            </div>
            <div className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                IDs
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {graph?.stats.totalIdentities ?? 0}
              </div>
            </div>
          </div>

          <div>
            <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
              Platform filter
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={`${RELATIONSHIPS_TOOLBAR_BUTTON_CLASS} ${platform === "all" ? "border-accent/40 bg-accent/14 text-txt" : ""}`}
                onClick={() => onPlatformChange("all")}
              >
                All
              </Button>
              {platforms.map((entry) => (
                <Button
                  key={entry}
                  type="button"
                  size="sm"
                  variant="outline"
                  className={`${RELATIONSHIPS_TOOLBAR_BUTTON_CLASS} ${platform === entry ? "border-accent/40 bg-accent/14 text-txt" : ""}`}
                  onClick={() => onPlatformChange(entry)}
                >
                  {entry}
                </Button>
              ))}
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className={RELATIONSHIPS_TOOLBAR_BUTTON_CLASS}
            onClick={onRefreshGraph}
          >
            {graphLoading ? "Refreshing…" : "Refresh graph"}
          </Button>
        </PagePanel.SummaryCard>

        <SidebarContent.SectionLabel className="mt-3">
          People
        </SidebarContent.SectionLabel>
        <SidebarScrollRegion className="mt-2">
          <div className="space-y-1.5">
            {graph?.people.map((person) => {
              const active = person.primaryEntityId === selectedPersonId;
              return (
                <SidebarContent.Item
                  key={person.groupId}
                  active={active}
                  onClick={() => onSelectPersonId(person.primaryEntityId)}
                  aria-current={active ? "page" : undefined}
                >
                  <SidebarContent.ItemIcon active={active}>
                    {person.displayName.charAt(0).toUpperCase()}
                  </SidebarContent.ItemIcon>
                  <span className="min-w-0 flex-1 text-left">
                    <SidebarContent.ItemTitle>
                      {person.displayName}
                    </SidebarContent.ItemTitle>
                    <SidebarContent.ItemDescription>
                      {person.isOwner
                        ? `Owner · ${summarizeHandles(person) || person.platforms.join(" • ") || "Canonical profile"}`
                        : summarizeHandles(person) ||
                          person.platforms.join(" • ") ||
                          "No handles yet"}
                    </SidebarContent.ItemDescription>
                  </span>
                  <MetaPill compact>{person.memberEntityIds.length}</MetaPill>
                </SidebarContent.Item>
              );
            })}
          </div>
        </SidebarScrollRegion>
      </SidebarPanel>
    </AppPageSidebar>
  );
}
