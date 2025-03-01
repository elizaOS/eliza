import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { useAgents } from "@/hooks/use-query-hooks";
import info from "@/lib/info.json";
import { Book, Cog, User } from "lucide-react";
import { NavLink, useLocation } from "react-router";
import ConnectionStatus from "./connection-status";
  
export function AppSidebar() {
  const location = useLocation();
  const { data: agentsData, isPending: isAgentsPending } = useAgents();

  return (
    <Sidebar className="bg-background">
      <SidebarHeader className="pb-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/" className="px-6 py-4">
                <img
                  alt="elizaos-icon"
                  src="/elizaos-icon.png"
                  width="100%"
                  height="100%"
                  className="size-9"
                />

                <div className="flex flex-col leading-none ">
                  <span className="font-semibold text-lg">ElizaOS</span>
                  <span className="text-sm -mt-0.5 text-muted-foreground">v{info?.version}</span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="px-6 py-2 text-sm font-medium text-muted-foreground">
            AGENTS
          </SidebarGroupLabel>
          <SidebarGroupContent className="px-2">
            <SidebarMenu>
              {isAgentsPending ? (
                <div>
                  {Array.from({ length: 5 }).map((_, _index) => (
                    <SidebarMenuItem key={`skeleton-item-${_index}`}>
                      <SidebarMenuSkeleton />
                    </SidebarMenuItem>
                  ))}
                </div>
              ) : (
                <div>
                  {(() => {
                    // Sort agents: enabled first, then disabled
                    const sortedAgents = [...(agentsData?.agents || [])].sort((a, b) => {
                      // Sort by enabled status (enabled agents first)
                      if (a.enabled && !b.enabled) return -1;
                      if (!a.enabled && b.enabled) return 1;
                      // If both have same enabled status, sort alphabetically by name
                      return a.character.name.localeCompare(b.character.name);
                    });
                    
                    // Split into enabled and disabled groups
                    const enabledAgents = sortedAgents.filter(agent => agent.enabled);
                    const disabledAgents = sortedAgents.filter(agent => !agent.enabled);
                    
                    return (
                      <>
                        {/* Render active section */}
                        {enabledAgents.length > 0 && (
                          <div className="px-4 py-2 mt-4">
                            <div className="flex items-center space-x-2">
                              <div className="size-2.5 rounded-full bg-green-500" />
                              <span className="text-sm font-medium text-muted-foreground">Active</span>
                            </div>
                          </div>
                        )}

                        {/* Render enabled agents */}
                        {enabledAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <NavLink to={`/chat/${agent.id}`}>
                              <SidebarMenuButton
                                isActive={location.pathname.includes(agent.id)}
                                className="transition-colors px-4 py-2 my-1 rounded-md"
                              >
                                <div className="flex items-center gap-2">
                                  
                                  <User className="size-5" />
                                  
                                  <span className="text-base">{agent.character.name}</span>
                                </div>
                              </SidebarMenuButton>
                            </NavLink>
                          </SidebarMenuItem>
                        ))}
                        
                        {/* Render inactive section */}
                        {disabledAgents.length > 0 && (
                          <div className="px-4 py-2 mt-4">
                            <div className="flex items-center space-x-2">
                              <div className="size-2.5 rounded-full bg-muted-foreground/50" />
                              <span className="text-sm font-medium text-muted-foreground">Inactive</span>
                            </div>
                          </div>
                        )}

                        {/* Render disabled agents */}
                        {disabledAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <NavLink to={`/chat/${agent.id}`}>
                              <SidebarMenuButton
                                isActive={location.pathname.includes(agent.id)}
                                className="transition-colors px-4 py-2 my-1 rounded-md text-muted-foreground"
                              >
                                <User className="size-5" />
                                <span className="text-base">{agent.character.name}</span>
                              </SidebarMenuButton>
                            </NavLink>
                          </SidebarMenuItem>
                        ))}
                      </>
                    );
                  })()}
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-4 py-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <NavLink
              to="https://elizaos.github.io/eliza/docs/intro/"
              target="_blank"
            >
              <SidebarMenuButton className="text-muted-foreground rounded-md">
                <Book className="size-5" /> 
                <span>Documentation</span>
              </SidebarMenuButton>
            </NavLink>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton disabled className="text-muted-foreground/50 rounded-md">
              <Cog className="size-5" /> 
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <ConnectionStatus />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
  