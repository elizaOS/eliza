import {
  MetaPill,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import type { RelationshipsGraphSnapshot } from "../../../api/client-types-relationships";
import { AppPageSidebar } from "../../shared/AppPageSidebar";
import { summarizeHandles } from "./relationships-utils";

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
          placeholder: "Search people, aliases, handles",
          "aria-label": "Search people, aliases, handles",
          onClear: onSearchClear,
        }}
      />
      <SidebarPanel>
        <SidebarContent.SectionLabel className="mt-2">
          People {graph ? `(${graph.people.length})` : ""}
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
