import { Crown } from "lucide-react";
import type { RelationshipsGraphSnapshot } from "../../../api/client-types-relationships";
import { SidebarContent } from "../../composites/sidebar/sidebar-content";
import { SidebarHeader } from "../../composites/sidebar/sidebar-header";
import { SidebarPanel } from "../../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../../shared/AppPageSidebar";

export function RelationshipsSidebar({
  search,
  graph,
  selectedPersonId,
  onSearchChange,
  onSearchClear,
  onSelectPersonId,
}: {
  search: string;
  graph: RelationshipsGraphSnapshot | null;
  selectedPersonId: string | null;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
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
          placeholder: "Search",
          "aria-label": "Search people",
          onClear: onSearchClear,
        }}
      />
      <SidebarPanel>
        <SidebarScrollRegion className="mt-2">
          <div className="space-y-1">
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
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <SidebarContent.ItemTitle>
                      {person.displayName}
                    </SidebarContent.ItemTitle>
                    {person.isOwner ? (
                      <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />
                    ) : null}
                  </span>
                </SidebarContent.Item>
              );
            })}
          </div>
        </SidebarScrollRegion>
      </SidebarPanel>
    </AppPageSidebar>
  );
}
