/**
 * The person-list sidebar for the Relationships view: renders the graph's people
 * as a selectable list and forwards `PageLayout`'s layout-injected sidebar props
 * (variant/close/className) so the mobile drawer renders its chrome correctly.
 */
import { Crown } from "lucide-react";
import type { RelationshipsGraphSnapshot } from "../../../api/client-types-relationships";
import { SidebarContent } from "../../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../../composites/sidebar/sidebar-scroll-region";
import {
  AppPageSidebar,
  type AppPageSidebarProps,
} from "../../shared/AppPageSidebar";

export function RelationshipsSidebar({
  graph,
  selectedPersonId,
  onSelectPersonId,
  ...sidebarProps
}: {
  graph: RelationshipsGraphSnapshot | null;
  selectedPersonId: string | null;
  onSelectPersonId: (personId: string) => void;
} & Omit<AppPageSidebarProps, "children">) {
  // Forward the layout-injected sidebar props (PageLayout's mobile drawer
  // clones this element with `variant="mobile"` / `onMobileClose` / a
  // className) so the drawer actually renders the mobile chrome.
  return (
    <AppPageSidebar
      testId="relationships-sidebar"
      collapsible
      contentIdentity="relationships"
      {...sidebarProps}
    >
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
