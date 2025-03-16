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
} from '@/components/ui/sidebar';
import { useAgents } from '@/hooks/use-query-hooks';
import info from '@/lib/info.json';
import { formatAgentName } from '@/lib/utils';
import { type Agent, AgentStatus } from '@elizaos/core';
import { Book, Cog, TerminalIcon } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';
import ConnectionStatus from './connection-status';

export function AppSidebar() {
  const location = useLocation();
  const { data: { data: agentsData } = {}, isPending: isAgentsPending } = useAgents();

  return (
    <Sidebar className="bg-background">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/" className="px-6 py-2 h-full">
                <div className="flex flex-col pt-2 gap-1 items-start justify-center">
                  <img alt="elizaos-logo" src="/elizaos-logo-light.png" width="90%" />
                  <span className="text-xs font-mono text-muted-foreground text-center">
                    v{info?.version}
                  </span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
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
                      // Sort by status (active agents first)
                      if (a.status === AgentStatus.ACTIVE && b.status !== AgentStatus.ACTIVE)
                        return -1;
                      if (a.status !== AgentStatus.ACTIVE && b.status === AgentStatus.ACTIVE)
                        return 1;
                      // If both have the same status, sort alphabetically by name
                      return a.name.localeCompare(b.name);
                    });

                    // Split into enabled and disabled groups
                    const activeAgents = sortedAgents.filter(
                      (agent: Partial<Agent & { status: string }>) =>
                        agent.status === AgentStatus.ACTIVE
                    );
                    const inactiveAgents = sortedAgents.filter(
                      (agent: Partial<Agent & { status: string }>) =>
                        agent.status === AgentStatus.INACTIVE
                    );

                    return (
                      <>
                        {/* Render active section */}
                        {activeAgents.length > 0 && (
                          <div className="px-4 py-1">
                            <div className="flex items-center space-x-2">
                              <span className="text-sm font-medium text-muted-foreground">
                                Online
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Render enabled agents */}
                        {activeAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <NavLink to={`/chat/${agent.id}`}>
                              <SidebarMenuButton
                                isActive={location.pathname.includes(agent.id as string)}
                                className="transition-colors px-4 my-4 rounded-md"
                              >
                                <div className="flex items-center gap-2">
                                  <div className="w-8 h-8 flex justify-center items-center">
                                    <div className="relative bg-muted rounded-full w-full h-full">
                                      {agent && (
                                        <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                          {agent.settings?.avatar ? (
                                            <img
                                              src={agent.settings?.avatar}
                                              alt="Agent Avatar"
                                              className="w-full h-full object-contain"
                                            />
                                          ) : (
                                            formatAgentName(agent.name)
                                          )}
                                          <div
                                            className={`absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-green-500`}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <span className="text-base">{agent.name}</span>
                                </div>
                              </SidebarMenuButton>
                            </NavLink>
                          </SidebarMenuItem>
                        ))}

                        {/* Render inactive section */}
                        {inactiveAgents.length > 0 && (
                          <div className="px-4 py-1 mt-8">
                            <div className="flex items-center space-x-2">
                              <span className="text-sm font-medium text-muted-foreground">
                                Offline
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Render disabled agents */}
                        {inactiveAgents.map((agent) => (
                          <SidebarMenuItem key={agent.id}>
                            <div className="transition-colors px-4 my-4 rounded-md">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 flex justify-center items-center">
                                  <div className="relative bg-muted rounded-full w-full h-full">
                                    {agent && (
                                      <div className="text-sm rounded-full h-full w-full flex justify-center items-center overflow-hidden">
                                        {agent.settings?.avatar ? (
                                          <img
                                            src={agent.settings.avatar}
                                            alt="Agent Avatar"
                                            className="w-full h-full object-contain"
                                          />
                                        ) : (
                                          formatAgentName(agent.name)
                                        )}
                                        <div
                                          className={`absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-[1px] border-white bg-muted-foreground`}
                                        />
                                      </div>
                                    )}
                                  </div>
                                </div>
                                <span className="text-base truncate max-w-24">{agent.name}</span>
                              </div>
                            </div>
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
            <NavLink to="https://elizaos.github.io/eliza/docs/intro/" target="_blank">
              <SidebarMenuButton className="text-muted-foreground rounded-md">
                <Book className="size-5" />
                <span>Documentation</span>
              </SidebarMenuButton>
            </NavLink>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <NavLink to="/logs">
              <SidebarMenuButton className="text-muted-foreground rounded-md">
                <TerminalIcon className="size-5" />
                <span>Logs</span>
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
