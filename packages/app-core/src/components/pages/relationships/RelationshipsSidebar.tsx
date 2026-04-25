import {
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import { Crown, Fingerprint, Link2 } from "lucide-react";
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
                    <span className="flex min-w-0 items-center gap-1.5">
                      <SidebarContent.ItemTitle>
                        {person.displayName}
                      </SidebarContent.ItemTitle>
                      {person.isOwner ? (
                        <Crown className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : null}
                    </span>
                    <SidebarContent.ItemDescription>
                      {person.isOwner
                        ? `Owner · ${summarizeHandles(person) || person.platforms.join(" • ") || "Primary profile"}`
                        : summarizeHandles(person) ||
                          person.platforms.join(" • ") ||
                          "No linked handles"}
                    </SidebarContent.ItemDescription>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-2xs font-semibold text-muted">
                    <span className="inline-flex items-center gap-1">
                      <Fingerprint className="h-3 w-3 text-accent" />
                      {person.memberEntityIds.length}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Link2 className="h-3 w-3 text-muted" />
                      {person.relationshipCount}
                    </span>
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
